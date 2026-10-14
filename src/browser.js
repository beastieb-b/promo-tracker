// The app's one Chrome: a persistent profile (cookies = logins live on disk)
// driven by Playwright. Postmates and Uber Eats block headless Chrome, and
// Reddit and the forum only serve a real headed browser, so it always runs
// headed.
//
// Two kinds of users share it:
//   - Exclusive work (an apply run, the self-test, a session check, a login
//     window) holds the LEASE — one at a time. isBusy()/holder() expose it.
//   - Source reads (Reddit, the forum) open short-lived pages alongside
//     whatever holds the lease, but stay out of the way of a login window.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const cfg = require('./config');

let _context = null;
let _launching = null;
let _closing = null;
let _lease = null;               // { kind, since, token }
const _readPages = new Set();    // pages opened by source reads

// ── Lease ────────────────────────────────────────────────────────────────────

// Take the browser for exclusive work. Returns a release function, or null if
// someone else holds it. The release only frees its own lease (a forced
// release may have handed the browser to someone else since).
function acquire(kind) {
  if (_lease) return null;
  const token = Symbol(kind);
  _lease = { kind, since: Date.now(), token };
  return () => { if (_lease && _lease.token === token) _lease = null; };
}

// Free a lease whose holder is wedged (the outer run deadline fired and the
// run never unwound). Only the given kind is freed.
function forceRelease(kind) {
  if (_lease && _lease.kind === kind) { _lease = null; return true; }
  return false;
}

function holder() { return _lease ? _lease.kind : null; }
function isBusy() { return !!_lease; }

// ── Deadlines ────────────────────────────────────────────────────────────────

// Hard deadline for browser work. Several Playwright calls have no timeout at
// all (evaluate, mouse.wheel, locator.count, newPage, context.close) and wait
// forever if a page's renderer freezes — which once held the scan slot for 10
// days, silently blocking every scan, a monthly rollover and the self-test.
function withDeadline(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded its ${Math.round(ms / 1000)}s deadline`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Playwright's locator.isVisible() ignores its timeout option and answers
// instantly, so "wait up to N s" checks written with it were one snapshot.
// This actually waits.
async function visibleWithin(locator, ms) {
  try { await locator.waitFor({ state: 'visible', timeout: ms }); return true; }
  catch { return false; }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

// Only one Chrome may run on the profile. Concurrent launches share one
// in-flight promise, and a launch waits for any in-flight close (the old
// Chrome holds the profile lock until it exits).
async function getBrowserContext() {
  if (_closing) await _closing;
  if (_context) return _context;
  if (!_launching) {
    _launching = (async () => {
      const { chromium } = require('playwright');
      const ctx = await chromium.launchPersistentContext(cfg.BROWSER_PROFILE_DIR, {
        channel: 'chrome',
        headless: false,
        chromiumSandbox: true,   // keeps Playwright from adding --no-sandbox
        // Without --enable-automation Chrome shows no "controlled by automated
        // software" infobar; the init script below hides navigator.webdriver.
        ignoreDefaultArgs: ['--enable-automation'],
        args: ['--no-first-run', '--disable-default-apps'],
        viewport: { width: 1280, height: 800 },
      });
      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
      _context = ctx;
      return ctx;
    })().finally(() => { _launching = null; });
  }
  return _launching;
}

// Open a new page, surviving a dead cached context: context.pages() never
// notices that Chrome quit, so newPage() is the liveness check, and a closed
// or wedged context is relaunched once.
async function getPage() {
  const ctx = await getBrowserContext();
  try {
    return await withDeadline(ctx.newPage(), 30000, 'Opening a browser page');
  } catch (err) {
    if (!/closed|deadline/i.test(err.message)) throw err;
    if (_context === ctx) await closeBrowser();
    const fresh = await getBrowserContext();
    return await withDeadline(fresh.newPage(), 30000, 'Opening a browser page');
  }
}

// Last resort when Chrome won't close: SIGKILL every process running on the
// app's profile, so the profile lock is released and the next launch works.
function killProfileChrome() {
  try { execFileSync('pkill', ['-9', '-f', cfg.BROWSER_PROFILE_DIR]); } catch {}
}

async function closeBrowser() {
  if (_launching) { try { await withDeadline(_launching, 200000, 'Browser launch'); } catch {} } // never orphan a Chrome mid-launch
  const ctx = _context;
  if (!ctx) return;
  _context = null; // detach first: new callers wait on _closing, then relaunch
  _readPages.clear();
  _closing = withDeadline(ctx.close(), 20000, 'Closing the browser')
    .catch(() => killProfileChrome())
    .finally(() => { _closing = null; });
  await _closing;
}

// Close a page without trusting it to cooperate: if close itself hangs (a
// frozen renderer), recycle the whole browser so nothing stays wedged.
async function closePageHard(page) {
  _readPages.delete(page);
  try { await withDeadline(page.close(), 10000, 'Closing a page'); }
  catch { await closeBrowser(); }
}

// Run `work(page)` on a fresh page under a hard deadline; the page is always
// closed. Pages opened here are source reads: a scan that overruns can close
// them without disturbing an apply run on the same browser.
async function withPage(label, ms, work) {
  const page = await getPage();
  _readPages.add(page);
  try { return await withDeadline(work(page), ms, label); }
  finally { await closePageHard(page); }
}

async function closeReadPages() {
  const pages = [..._readPages];
  _readPages.clear();
  await Promise.all(pages.map(p => withDeadline(p.close(), 10000, 'Closing a page').catch(() => {})));
  return pages.length;
}

// Playwright retains per-page state for the life of a context (~1 MB per heavy
// Reddit/forum page), so a never-recycled context leaked ~310 MB/day until the
// daemon ran out of memory. Recycle Chrome after each scan whenever nothing
// else is using it; the next user relaunches it in ~2 s and logins survive in
// the profile.
async function recycleIfIdle() {
  // All checks are synchronous and closeBrowser detaches before its first
  // await, so nothing can claim the browser between the check and the close.
  if (_lease || _launching || !_context || _readPages.size) return false;
  await closeBrowser();
  return true;
}

// The open browser context (null when Chrome isn't running).
function currentContext() { return _context; }

async function saveDebugScreenshot(page, prefix) {
  try {
    fs.mkdirSync(cfg.DEBUG_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await withDeadline(page.screenshot({ path: path.join(cfg.DEBUG_DIR, `${prefix}-${ts}.png`), fullPage: false }), 10000, 'Screenshot');
  } catch {}
}

module.exports = {
  acquire, forceRelease, holder, isBusy,
  withDeadline, visibleWithin,
  getBrowserContext, getPage, closeBrowser, closePageHard, withPage, closeReadPages,
  recycleIfIdle, currentContext, saveDebugScreenshot,
};
