#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const state = require('./state');

// Prefix every console line with an ISO timestamp so the daemon logs are dated.
(() => {
  const stamp = () => `[${new Date().toISOString()}]`;
  const log = console.log.bind(console);
  const err = console.error.bind(console);
  console.log = (...a) => log(stamp(), ...a);
  console.error = (...a) => err(stamp(), ...a);
})();

const args = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write(`Promo Tracker ${require('./version').label()}\n`);
  process.exit(0);
}

// ── Access links for other devices (no lock needed: reads config only) ──────
if (args.includes('--access-link')) {
  const access = require('./access');
  if (!access.networkAccess()) {
    console.log('Network access is off — only this Mac can open the dashboard.');
    console.log('To use it from other devices, set "host": "0.0.0.0" in config.local.json and restart.');
  } else {
    console.log('Open one of these once on each phone/laptop (keep them private):');
    for (const link of access.accessLinks()) console.log('  ' + link);
  }
  process.exit(0);
}

state.ensureDirs();

// One process at a time drives the Chrome profile and the state files.
const role = args.includes('--setup') ? 'setup' : args.includes('--reddit') ? 'scan'
  : args.includes('--apply') ? 'apply' : 'daemon';
const held = require('./lock').acquireLock(role);
if (held) {
  console.error(`Promo Tracker is already running (pid ${held.pid}, ${held.role}). ` +
    (role === 'daemon' ? 'Not starting a second copy.' : 'Use the dashboard instead, or stop the app first.'));
  process.exit(1);
}

const browser = require('./browser');

// ── One-off CLI runs ─────────────────────────────────────────────────────────

async function cli(work) {
  let code = 0;
  try { await work(); }
  catch (err) { console.error(err.message); code = 1; }
  await browser.closeBrowser();
  process.exit(code);
}

if (role === 'setup') {
  const target = args.includes('ubereats') ? 'ubereats' : 'postmates';
  const i = args.indexOf('--account');
  const accountId = i >= 0 && args[i + 1] ? args[i + 1] : 'main';
  cli(() => require('./login').setupLogin({ target, accountId }));
  return;
}
if (role === 'scan') {
  cli(async () => console.log('Scan result:', JSON.stringify(await require('./reddit').runRedditCheck(), null, 2)));
  return;
}
if (role === 'apply') {
  cli(async () => {
    const result = await require('./runner').runApplyCodes({
      onProgress: (u) => console.log('  →', u.code, u.status, u.detail || ''),
    });
    console.log('Apply result:', JSON.stringify(result, null, 2));
  });
  return;
}

// ── Daemon ───────────────────────────────────────────────────────────────────

const cron = require('node-cron');
const settings = require('./settings');
const reddit = require('./reddit');
const reads = require('./reads');
const runner = require('./runner');
const login = require('./login');
const server = require('./server');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const running = { scan: false, apply: false };
let scanTask = null;
let applyTask = null;
let lastRateLimitedAt = null; // when an apply run last hit the rate limiter
// When an apply run last ACTUALLY attempted codes (not the no-op "queue is
// empty" cron wake-ups) — the apply-on-arrival gap is measured from it.
let lastCodeApplyAt = null;

const scanStatus = {
  active: false,          // set once crons are scheduled
  scanRunning: false,
  scanStartedAt: null,
  lastScanAt: null,
  lastScanError: null,
  nextScanAt: null,
  intervalHours: 2,
  applyIntervalHours: 4,
  applyRunning: false,
  applyStartedAt: null,
  applyCurrentCode: null,
  lastApplyAt: null,
  nextApplyAt: null,
};

function getScanStatus() {
  return { ...scanStatus, browserBusy: browser.holder() };
}

function updateNextRunTimes() {
  scanStatus.nextScanAt = settings.nextRunFromInterval(scanStatus.intervalHours);
  scanStatus.nextApplyAt = settings.nextRunFromInterval(scanStatus.applyIntervalHours);
}

// Outer safety net. Every browser read and code attempt has its own deadline;
// if a whole run still overruns, `onDeadline` unsticks it (pending Playwright
// calls then reject), the run gets a moment to unwind, and the slot frees.
async function guardRun(promise, ms, label, onDeadline, settleMs = 20000) {
  try {
    return await browser.withDeadline(promise, ms, label);
  } catch (err) {
    if (!/deadline/.test(err.message)) throw err;
    console.error(`  ⛔ ${err.message} — unsticking the browser`);
    state.appendLog({ type: 'run_deadline', what: label, error: err.message });
    await onDeadline();
    await Promise.race([promise.catch(() => {}), sleep(settleMs)]);
    return { error: err.message, deadline: true };
  }
}

async function runScan() {
  if (running.scan) return { error: 'A source scan is already running', busy: true };
  running.scan = true;
  Object.assign(scanStatus, { scanRunning: true, scanStartedAt: new Date(), lastScanError: null });
  server.broadcast({ type: 'scan_started', scanStatus: getScanStatus() });
  let result;
  try {
    console.log('Running source scan...');
    // On a deadline, cancel the scan (its remaining reads fail at once) and
    // close only its own pages: an apply run may be using the same browser
    // and must not be killed by a stuck read. Then wait for the scan to
    // actually stop (reads have their own ≤150 s deadlines) so two scans
    // never run at once.
    const scan = reads.runScan(() =>
      reddit.runRedditCheck({ onProgress: (p) => server.broadcast({ type: 'reddit_progress', ...p }) }));
    result = await guardRun(scan.promise, cfg.SCAN_DEADLINE_MS, 'Source scan', async () => {
      scan.ctx.cancelled = true;
      await browser.closeReadPages();
      await browser.recycleIfIdle();
    }, 3 * 60000);
  } catch (err) {
    console.error('Source scan crashed:', err.message);
    result = { error: err.message };
  }

  running.scan = false;
  Object.assign(scanStatus, { scanRunning: false, scanStartedAt: null, lastScanAt: new Date() });
  updateNextRunTimes();
  if (result.error) {
    scanStatus.lastScanError = result.error;
    console.error('  Scan error:', result.error);
  } else {
    state.recordHeartbeat('scan'); // for the staleness watchdog
    const pm = result.postmates, ue = result.ubereats, us = result.uscf;
    console.log(`  r/postmates: ${pm?.threadId || '?'} | ${pm?.commentsScanned ?? 0} comments | ${pm?.newCodes ?? 0} new`);
    console.log(`  r/UberEATS:  ${ue?.threadId || '?'} | ${ue?.commentsScanned ?? 0} comments | ${ue?.newCodes ?? 0} new`);
    if (us) console.log(`  USCardForum: ${us.error ? 'ERROR — ' + us.error : `${us.commentsScanned ?? 0} new posts | ${us.newCodes ?? 0} new`}`);
    if (result.queued > 0) console.log(`  Queued: ${result.queued} codes`);
    maybeApplyOnArrival(result.queued);
  }
  server.broadcast({ type: 'reddit_done', ...result, scanStatus: getScanStatus() });
  return result;
}

// Apply on arrival: fresh codes are time-sensitive (limited redemptions), so
// start an apply run now instead of waiting for the cron — never while the
// browser is busy, at most once per ARRIVAL_MIN_GAP_MS since the last run
// that attempted codes, and not within RATE_LIMIT_BACKOFF_MS of a rate limit.
// Both times survive restarts via the heartbeat file.
function maybeApplyOnArrival(queued) {
  if (!(queued > 0)) return;
  const hb = state.getHeartbeat();
  if (running.apply || browser.isBusy()) {
    state.appendLog({ type: 'apply_on_arrival_skipped', queued, note: `browser busy (${browser.holder() || 'apply run'}) — codes wait for the next scheduled run` });
    return;
  }
  const go = settings.shouldApplyOnArrival({
    queued,
    applyRunning: running.apply,
    lastApplyAt: lastCodeApplyAt || hb.codeApply || null,
    lastRateLimitedAt: lastRateLimitedAt || hb.ratelimited || null,
  });
  if (!go) return;
  state.appendLog({ type: 'apply_on_arrival', queued });
  console.log(`  ⚡ ${queued} new code(s) — starting apply run now`);
  runApply(); // not awaited — the scan result returns immediately
}

async function runApply() {
  if (running.apply) return { error: 'An apply run is already running', busy: true };
  running.apply = true;
  Object.assign(scanStatus, { applyRunning: true, applyStartedAt: new Date(), applyCurrentCode: null });
  server.broadcast({ type: 'apply_started', scanStatus: getScanStatus() });
  let result;
  try {
    console.log('Running code applier...');
    const run = runner.runApplyCodes({
      onProgress: (u) => {
        console.log(`  → ${u.code}: ${u.status}${u.detail ? ' — ' + u.detail : ''}`);
        if (u.status === 'trying') scanStatus.applyCurrentCode = u.code;
        server.broadcast({ type: 'apply_progress', ...u, scanStatus: getScanStatus() });
      },
    });
    // Each account gets its own budget (see runner), so the deadline scales.
    const accountCount = require('./accounts').active().length;
    result = await guardRun(run, cfg.APPLY_DEADLINE_MS * accountCount, 'Apply run', () => browser.closeBrowser());
    if (result.deadline) browser.forceRelease('apply');
  } catch (err) {
    console.error('Apply run crashed:', err.message);
    result = { error: err.message };
  }

  running.apply = false;
  Object.assign(scanStatus, { applyRunning: false, applyCurrentCode: null, applyStartedAt: null, lastApplyAt: new Date() });
  updateNextRunTimes();
  if (result.error) {
    console.error('  Apply error:', result.error);
  } else {
    const successes = result.results?.filter(r => r.result === 'success').length ?? 0;
    console.log(`  Applied: ${result.applied} | Successes: ${successes}`);
    state.recordHeartbeat('apply'); // for the staleness watchdog
  }
  if (result.rateLimited) {
    lastRateLimitedAt = new Date();
    state.recordHeartbeat('ratelimited');
  }
  if (!result.error && (result.applied ?? 0) > 0) {
    lastCodeApplyAt = new Date();
    state.recordHeartbeat('codeApply');
  }
  server.broadcast({ type: 'apply_done', ...result, scanStatus: getScanStatus() });
  return result;
}

function reschedule(newSettings) {
  const s = newSettings || settings.load();
  if (scanTask) { scanTask.stop(); scanTask = null; }
  if (applyTask) { applyTask.stop(); applyTask = null; }

  const scanCron = settings.hoursToCron(s.scanIntervalHours);
  const applyCron = settings.hoursToCron(s.applyIntervalHours);
  // Schedules run on this machine's local time (set TZ to override).
  scanTask = cron.schedule(scanCron, () => runScan());
  applyTask = cron.schedule(applyCron, () => runApply());

  Object.assign(scanStatus, { active: true, intervalHours: s.scanIntervalHours, applyIntervalHours: s.applyIntervalHours });
  updateNextRunTimes();
  console.log(`📅 Source scan: every ${s.scanIntervalHours}h (${scanCron})`);
  console.log(`📅 Code applier: every ${s.applyIntervalHours}h (${applyCron})`);
  server.broadcast({ type: 'settings_updated', settings: s, scanStatus: getScanStatus() });
}

// Housekeeping for long uptimes (runs at boot and daily).
function runMaintenance(reason) {
  const trim = (file, maxLines, keepLines) => {
    try {
      if (!fs.existsSync(file)) return;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      if (lines.length > maxLines) {
        // launchd opens the daemon logs with O_APPEND, so writes always go to
        // the real end — rewriting the content here is safe.
        fs.writeFileSync(file, lines.slice(-keepLines).join('\n') + '\n');
        console.log(`[maintenance:${reason}] Trimmed ${path.basename(file)} (${lines.length} → ${keepLines} lines)`);
      }
    } catch {}
  };
  trim(path.join(cfg.DATA_DIR, 'daemon.log'), 1200, 1000);
  trim(path.join(cfg.DATA_DIR, 'daemon-error.log'), 1200, 1000);
  // The Activity Log endpoint parses this file per view; ~5000 entries is weeks.
  trim(cfg.LOG_FILE, 6000, 5000);
  // A failed attempt saves a debug screenshot; two weeks is plenty.
  try {
    const cutoff = Date.now() - 14 * 86400000;
    for (const f of fs.readdirSync(cfg.DEBUG_DIR)) {
      const p = path.join(cfg.DEBUG_DIR, f);
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch {}
}

// Daily self-test (a fake code must be rejected — catches a site UI change
// within a day) and an Uber Eats session check (nothing else touches that
// login between sporadic fallbacks). If a run holds the browser, retry every
// few minutes for up to half an hour rather than skipping the day.
async function runDailyCheck(triesLeft = 10) {
  if (running.scan || running.apply || browser.isBusy()) {
    if (triesLeft > 0) { setTimeout(() => runDailyCheck(triesLeft - 1), 3 * 60000); return; }
    console.log('Daily check skipped — the browser stayed busy for 30 minutes (will run tomorrow)');
    state.appendLog({ type: 'self_test', ok: null, error: 'skipped — browser busy for 30 minutes' });
    return;
  }
  console.log('Running daily self-test...');
  try {
    const result = await runner.testDetection();
    server.broadcast({ type: 'self_test_done', ...result });
    console.log(result.ok ? '  ✅ Self-test passed' : `  ⚠️ Self-test failed: ${result.error || result.message}`);
  } catch (err) {
    console.error('  Self-test crashed:', err.message);
  }
  const multi = require('./accounts').enabled();
  for (const account of require('./accounts').active()) {
    const who = multi ? ` (${account.name})` : '';
    try {
      const v = await login.verifySession('ubereats', account.id);
      server.broadcast({ type: 'session_verified', platform: 'ubereats', ok: v.verified, error: v.error || null, account: account.id, accountName: account.name });
      console.log(v.verified === true ? `  ✅ Uber Eats session verified${who}`
        : v.verified === false ? `  ⚠️ Uber Eats session expired${who} — dashboard banner raised`
        : `  ❓ Uber Eats session check inconclusive${who}${v.error ? ` (${v.error})` : ''}`);
    } catch (err) {
      console.error(`  Uber Eats session check crashed${who}:`, err.message);
    }
  }
}

async function main() {
  const noSchedule = args.includes('--no-schedule'); // dashboard only (development)
  console.log(`🍔 Promo Tracker ${require('./version').label()} starting${noSchedule ? ' (dashboard only — no scheduled runs)' : ''}...`);

  server.registerHooks({
    runScan, runApply, getScanStatus,
    // Dashboard-only mode never schedules anything, even after a settings change.
    reschedule: noSchedule ? (s) => server.broadcast({ type: 'settings_updated', settings: s, scanStatus: getScanStatus() }) : reschedule,
    isScanRunning: () => running.scan,
    isApplyRunning: () => running.apply,
    shutdown: () => browser.closeBrowser(),
  });
  if (require('./access').networkAccess()) require('./access').getToken();
  await server.start();

  const shutdown = async (signal) => {
    console.log(`\nShutting down (${signal})...`);
    await browser.closeBrowser();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM')); // launchd unload sends SIGTERM

  if (noSchedule) return;

  runMaintenance('startup');
  cron.schedule(cfg.MAINTENANCE_CRON, () => runMaintenance('daily'));
  cron.schedule(cfg.DAILY_CHECK_CRON, () => runDailyCheck());
  reschedule(settings.load());

  await runScan(); // catch up right away after a restart or wake
  console.log(`\n✅ Daemon running. Dashboard: http://localhost:${cfg.DASHBOARD_PORT}\n`);
}

main().catch(err => {
  console.error('Fatal startup error:', err.message);
  process.exit(1);
});
