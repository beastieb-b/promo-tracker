// Driving the promo-code modal on Postmates and Uber Eats. Both sites use the
// same Uber feed modal, so one flow serves both; only the URLs, the "still on
// the site" check and which session flag to update differ.

const cfg = require('./config');
const state = require('./state');
const session = require('./session');
const { visibleWithin, saveDebugScreenshot } = require('./browser');
const { classify } = require('./classify');

const PLATFORMS = {
  postmates: {
    key: 'postmates',
    name: 'Postmates',
    promoUrl: cfg.PROMO_URL,
    homeUrl: 'https://postmates.com',       // warm-up that reliably restores the session
    loginUrl: 'https://postmates.com',
    onDomain: (url) => url.includes('postmates.com') && !/\/login|\/signin/.test(url),
  },
  ubereats: {
    key: 'ubereats',
    name: 'Uber Eats',
    promoUrl: cfg.UBEREATS_PROMO_URL,
    homeUrl: 'https://www.ubereats.com',
    loginUrl: 'https://www.ubereats.com/',
    onDomain: (url) => url.includes('ubereats.com') && !/\/login|\/signin|auth\.uber\.com/.test(url),
  },
};

// Scope to dialogs that contain an input so we never grab a cookie banner or
// address confirmation modal that happens to appear at the same time.
const MODAL_SELECTOR = '[role="dialog"]:has(input), [aria-modal="true"]:has(input)';

async function dismissPopups(page) {
  // Cookie banners / consent notices. Deliberately excludes 'Close' and
  // 'Dismiss': those are the promo modal's own X button.
  for (const text of ['Got it', 'Accept', 'OK', 'DONE']) {
    try {
      const btn = page.getByRole('button', { name: text, exact: true });
      if (await btn.isVisible()) {
        await btn.click({ timeout: 5000 });
        await page.waitForTimeout(400);
      }
    } catch {}
  }
}

// The site sometimes covers the code-entry modal with an offer modal ("Enjoy
// 20% Off … See eligible stores") that has no input. Close it (Escape) so the
// code-entry modal underneath can be reached; never touch a dialog with an
// input — that's the code-entry modal.
async function dismissNoInputModal(page) {
  const dialog = page.locator('[role="dialog"], [aria-modal="true"]').first();
  if (!(await dialog.isVisible().catch(() => false))) return false;
  if (await dialog.locator('input').first().isVisible().catch(() => false)) return false;
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(600);
  return true;
}

// A logged-out page has "Log in"/"Sign up" links into /login-redirect/; a
// logged-in page has none. (A plain "Sign up" test also matched the footer's
// "Sign up to deliver" driver link on logged-IN pages — the source of
// repeated false "session expired" alarms.) Cookies can't answer this: an
// expired session keeps its unexpired auth cookie.
async function looksLoggedOut(page) {
  try {
    if (await page.locator('a[href*="login-redirect"]').first().isVisible().catch(() => false)) return true;
    const logIn = page.getByRole('link', { name: /^(log\s*in|sign\s*in)$/i })
      .or(page.getByRole('button', { name: /^(log\s*in|sign\s*in)$/i }));
    return await logIn.first().isVisible().catch(() => false);
  } catch { return false; }
}

// When the site's own session lapses, the Uber account sign-in behind it
// usually hasn't: following the page's "Log in" link goes through
// auth.uber.com and lands straight back, logged in, with no password. Do that
// before ever calling a session dead. Nothing is ever typed: if Uber shows a
// sign-in form instead, we never get back to the site, and the login really
// is gone ('needs_login').
async function ssoRelogin(page, plat) {
  // Follow the visible header link's address rather than clicking it: the page
  // also carries hidden duplicates (an off-screen menu) and a cookie banner,
  // and a click on the wrong copy just times out.
  const href = await page.evaluate(() => {
    const isLogin = a => /^(log\s*in|sign\s*in)$/i.test((a.innerText || '').trim());
    const isAuth = a => /login-redirect|auth\.uber\.com/.test(a.getAttribute('href') || '');
    const onScreen = a => { const r = a.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0; };
    const links = [...document.querySelectorAll('a[href]')];
    const pick = links.find(a => isLogin(a) && onScreen(a)) || links.find(a => isAuth(a) && onScreen(a)) || links.find(isLogin);
    return pick ? pick.href : null;
  }).catch(() => null);
  if (!href) return 'failed';
  try {
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForURL(u => plat.onDomain(String(u)) && !/login-redirect/.test(String(u)), { timeout: 30000 });
    await page.waitForTimeout(2500);
    const ok = !(await looksLoggedOut(page));
    state.appendLog({ type: 'sso_relogin', platform: plat.name, ok });
    return ok ? 'ok' : 'failed';
  } catch (err) {
    const needsLogin = /^https:\/\/auth\.uber\.com\//.test(page.url());
    state.appendLog({ type: 'sso_relogin', platform: plat.name, ok: false, needsLogin, error: err.message.split('\n')[0].slice(0, 90), url: page.url().slice(0, 80) });
    return needsLogin ? 'needs_login' : 'failed';
  }
}

// Navigate to the promo deep-link and get the code-entry modal open, through
// interstitials and transient blips. The deep-link occasionally comes back as
// the logged-out landing page even when the session is valid, so "logged out"
// is never concluded from one read: first press Log in (ssoRelogin), then warm
// the session via the home feed, retrying in between. Returns:
//   'open'       — code-entry modal is visible (session definitely valid)
//   'off_domain' — bounced off the site entirely (not logged in)
//   'logged_out' — still logged out after all that (session dead)
//   'blocked'    — logged-in-looking, but the modal never opened
async function openPromoModal(page, plat) {
  await page.goto(plat.promoUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);
  await dismissPopups(page);

  if (!plat.onDomain(page.url())) return 'off_domain';

  let modalOpen = false;
  let sawLoggedOut = false;
  let triedSignIn = false;
  for (let attempt = 0; attempt < 3 && !modalOpen; attempt++) {
    if (attempt > 0) {
      if (sawLoggedOut && !triedSignIn) {
        triedSignIn = true;
        if ((await ssoRelogin(page, plat)) === 'needs_login') return 'logged_out';
      } else if (sawLoggedOut && plat.homeUrl) {
        await page.goto(plat.homeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(2000);
      }
      await page.goto(plat.promoUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2500);
    }
    await dismissPopups(page);
    await dismissNoInputModal(page);
    modalOpen = await visibleWithin(page.locator(MODAL_SELECTOR).first(), 8000);
    if (!modalOpen) sawLoggedOut = await looksLoggedOut(page);
  }
  if (modalOpen) return 'open';

  await saveDebugScreenshot(page, 'no-modal');
  return (await looksLoggedOut(page)) ? 'logged_out' : 'blocked';
}

// Text of every visible dialog (the result can land in the code-entry modal or
// in a confirmation interstitial on top of it). inDialog=false means no dialog
// is showing at all; then only a rate-limit notice elsewhere on the page is
// worth reading (a toast) — the rest of the page is unrelated text.
async function getResultText(page) {
  return page.evaluate(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
      .filter(d => d.getClientRects().length > 0);
    return {
      inDialog: dialogs.length > 0,
      text: dialogs.map(d => d.innerText).join('\n').toLowerCase(),
      pageRateLimited: !dialogs.length && /too\s*many requests|rate limit|slow down/i.test(document.body.innerText),
    };
  });
}

const INPUT_SELECTORS = [
  'input[placeholder*="promo" i]',
  'input[placeholder*="code" i]',
  'input[data-testid*="promo"]',
  'input[name*="promo"]',
  'input[aria-label*="promo" i]',
  'input[aria-label*="code" i]',
];

// Type the code into the open modal and verify it landed. The site sometimes
// re-renders and detaches the modal mid-entry; short explicit timeouts plus
// one reopen-and-retype keep that from costing the attempt.
// Returns { input } or { error }.
async function enterCode(page, plat, code) {
  const modal = page.locator(MODAL_SELECTOR).first();
  for (let entryAttempt = 0; entryAttempt < 2; entryAttempt++) {
    if (entryAttempt > 0) {
      if ((await openPromoModal(page, plat)) !== 'open') return { error: 'Promo modal closed mid-entry and did not reopen' };
    }
    try {
      await visibleWithin(modal.locator('input').first(), 5000);
      let input = null;
      for (const sel of INPUT_SELECTORS) {
        const cand = modal.locator(sel).first();
        if (await cand.isVisible().catch(() => false)) { input = cand; break; }
      }
      if (!input) {
        const cand = modal.locator('input').first();
        if (await cand.isVisible().catch(() => false)) input = cand;
      }
      if (!input) {
        if (entryAttempt > 0) return { error: 'Could not find promo input inside modal' };
        continue;
      }

      await input.click({ clickCount: 3, timeout: 5000 });
      await input.fill('', { timeout: 5000 });
      await page.keyboard.type(code, { delay: 80 });
      await page.waitForTimeout(500);

      let val = await input.inputValue({ timeout: 5000 });
      if (!val.trim()) {
        await input.fill('', { timeout: 5000 });
        for (const char of code) {
          await page.keyboard.type(char);
          await page.waitForTimeout(50);
        }
        await page.waitForTimeout(500);
        val = await input.inputValue({ timeout: 5000 });
        if (!val.trim()) return { error: 'Text did not appear in input field' };
      }
      return { input };
    } catch (err) {
      if (entryAttempt > 0) return { error: 'Promo modal closed mid-entry (site re-render)' };
      state.appendLog({ type: 'modal_reopen', code, platform: plat.key, error: err.message.slice(0, 80) });
    }
  }
  return { error: 'Could not find promo input inside modal' };
}

// Click Apply. (These isVisible() calls are deliberate one-shot checks: a
// name that matches several buttons throws and falls through to the next
// candidate, and finally to Enter in the input.)
async function clickApply(page, input) {
  for (const text of ['Apply', 'Redeem', 'Submit']) {
    try {
      const btn = page.getByRole('button', { name: text, exact: false });
      if (await btn.isVisible()) { await btn.click({ timeout: 10000 }); return; }
    } catch {}
  }
  try {
    const btn = page.locator('[data-testid*="apply"]');
    if (await btn.isVisible()) { await btn.click({ timeout: 10000 }); return; }
  } catch {}
  await input.press('Enter');
}

// Poll for the verdict (~12 s). { result: 'closed' } means the code-entry
// modal went away without a readable verdict — the caller confirms what
// happened instead of guessing.
async function detectResult(page, beforeText) {
  let modalGone = false;
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(2000);
    const { text, inDialog, pageRateLimited } = await getResultText(page);
    if (inDialog) {
      const verdict = classify(text, beforeText);
      // An error the site showed for this code (as opposed to our own trouble
      // opening the box) counts toward giving up on the code.
      if (verdict) return verdict.result === 'error' ? { ...verdict, codeSpecific: true } : verdict;
    } else if (pageRateLimited) {
      return { result: 'ratelimited', detail: 'Rate limit detected' };
    }
    modalGone = !(await page.locator(MODAL_SELECTOR).first().isVisible().catch(() => false));
    if (modalGone && !inDialog) return { result: 'closed' };
  }
  if (modalGone) return { result: 'closed' };
  await saveDebugScreenshot(page, 'unknown');
  return { result: 'unknown', detail: 'Could not determine result', codeSpecific: true };
}

// Open the modal, type the code, apply, read the verdict.
async function attempt(page, plat, code) {
  const outcome = await openPromoModal(page, plat);
  if (outcome === 'off_domain') {
    session.set(plat.key, false);
    return { result: 'not_logged_in', detail: `Redirected — use Settings → Log in to ${plat.name}` };
  }
  if (outcome === 'logged_out') {
    session.set(plat.key, false);
    return { result: 'not_logged_in', detail: `${plat.name} session expired — Settings → Log in to ${plat.name}` };
  }
  if (outcome === 'blocked') return { result: 'error', detail: 'Promo modal did not open' };
  session.set(plat.key, true); // the modal opened: the session works

  const entered = await enterCode(page, plat, code);
  if (entered.error) return { result: 'error', detail: entered.error };

  // Snapshot BEFORE applying: only text that appears afterwards is the result.
  const before = await getResultText(page);
  await clickApply(page, entered.input);
  return detectResult(page, before.text);
}

// Apply one code. When the modal just closes with no message, apply the code
// again to find out what happened: "you already applied this promotion"
// proves the first attempt worked (a code that failed shows its rejection the
// second time). The amount isn't knowable then, so the win is recorded as
// "Applied!" rather than guessed from unrelated page text. If the modal closes
// silently again, it's counted as applied: rejections are spelled out in the
// modal, and so far every silent close has turned out to be a success.
async function applyCode(page, code, platform = 'postmates', { onConfirm } = {}) {
  const plat = PLATFORMS[platform] || PLATFORMS.postmates;
  const first = await attempt(page, plat, code);
  if (first.result !== 'closed') return first;

  onConfirm?.();
  const second = await attempt(page, plat, code);
  let verdict;
  if ((second.result === 'success' && second.detail === 'Already applied')
      || (second.result === 'rejected' && second.detail === 'Already used')) {
    // "Already applied" / "already been used" right after a silent close is
    // the first attempt's own win.
    verdict = { result: 'success', detail: 'Applied!' };
  } else if (second.result === 'closed') {
    verdict = { result: 'success', detail: 'Applied!' };
  } else {
    verdict = second; // the first attempt evidently didn't apply; this is the real verdict
  }
  state.appendLog({ type: 'confirm_pass', code, platform: plat.key, result: verdict.result, detail: verdict.detail });
  return verdict;
}

module.exports = { PLATFORMS, applyCode, openPromoModal, looksLoggedOut };
