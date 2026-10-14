// Logging in (a Chrome window the user signs in with) and checking that a
// saved login still works (navigation only — nothing is typed or applied).

const cfg = require('./config');
const state = require('./state');
const session = require('./session');
const browser = require('./browser');
const { PLATFORMS, openPromoModal } = require('./promo');

// Open the site in the app's Chrome for the user to log in, and wait until
// they close the window. Gives up after LOGIN_TIMEOUT_MS (closing the window
// itself) so a forgotten window can't hold the browser — and with it every
// apply run and session check — indefinitely.
// Resolves to { closed: 'user' | 'timeout' }.
async function setupLogin({ target = 'postmates', timeoutMs = cfg.LOGIN_TIMEOUT_MS } = {}) {
  const release = browser.acquire('login');
  if (!release) {
    throw new Error(browser.holder() === 'login'
      ? 'A login window is already open'
      : 'Browser is busy (apply run or session check) — try again in a moment');
  }
  const plat = PLATFORMS[target] || PLATFORMS.postmates;
  console.log(`\n🔐 Opening ${plat.name} in Chrome for login — log in, then close the window.\n`);

  try {
    const page = await browser.getPage();
    const ctx = page.context();
    await page.goto(plat.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

    // Done when the user closes the window (the context closes, or its last
    // tab does), or when time runs out.
    const closed = await new Promise(resolve => {
      let timer = null;
      let poll = null;
      const finish = (how) => { clearTimeout(timer); clearInterval(poll); resolve(how); };
      ctx.once('close', () => finish('user'));
      poll = setInterval(() => { if (ctx.pages().length === 0) finish('user'); }, 1000);
      timer = setTimeout(() => finish('timeout'), timeoutMs);
    });

    // Close through the browser module so a relaunch waits for this Chrome to
    // let go of the profile.
    if (browser.currentContext() === ctx) await browser.closeBrowser();
    else await ctx.close().catch(() => {});
    if (closed === 'timeout') {
      state.appendLog({ type: 'login_timeout', platform: plat.name, minutes: Math.round(timeoutMs / 60000) });
      console.log(`⌛ ${plat.name} login window closed after ${Math.round(timeoutMs / 60000)} minutes.`);
    } else {
      console.log(`✅ Browser closed — ${plat.name} login saved.`);
    }
    session.set(plat.key, null); // confirmed by the session check that follows
    return { closed };
  } finally {
    release();
  }
}

// Codes Postmates rejected while Uber Eats was logged out never got their
// Uber Eats attempt. Once Uber Eats works again, move them back into the
// queue flagged ueOnly, so the next run goes straight to Uber Eats.
function requeuePendingUberEats() {
  const pending = Object.entries(state.getCodeCatalog().codes)
    .filter(([, m]) => m && m.pendingUberEats).map(([c]) => c);
  for (const code of pending) {
    state.requeueResult(code);
    state.mergeCodeMeta(code, { pendingUberEats: false, ueOnly: true });
  }
  if (pending.length) state.appendLog({ type: 'ubereats_requeue', codes: pending, note: 'Uber Eats session back — retrying the codes it missed' });
  return pending.length;
}

// Session probe: open the promo modal and report whether the login works.
// Definitive outcomes update the session flag; 'blocked' is inconclusive and
// leaves it alone. Busy early-outs are logged — a silently skipped check once
// left the dashboard on "Unverified" with no clue why.
async function verifySession(platform = 'postmates') {
  const plat = PLATFORMS[platform] || PLATFORMS.postmates;
  const release = browser.acquire('session');
  if (!release) {
    const why = `skipped — browser busy (${browser.holder()})`;
    state.appendLog({ type: 'session_verified', platform, ok: null, error: why });
    return { verified: null, error: why };
  }
  let page = null;
  try {
    page = await browser.getPage();
    const outcome = await browser.withDeadline(openPromoModal(page, plat), cfg.SESSION_CHECK_MS, 'Session check');
    const verified = outcome === 'open' ? true
      : (outcome === 'off_domain' || outcome === 'logged_out') ? false
      : null;
    if (verified !== null) session.set(plat.key, verified);
    if (platform === 'ubereats' && verified === true) requeuePendingUberEats();
    if (verified === true) {
      // A working session retires a self-test banner raised by a logged-out
      // verdict — that failure is resolved now.
      const hw = state.getHealthWarning();
      if (hw && hw.source === 'self_test' && /not_logged_in/.test(hw.message || '')) state.clearHealthWarning();
    }
    state.appendLog({ type: 'session_verified', platform, ok: verified, outcome });
    return { verified, outcome };
  } catch (err) {
    state.appendLog({ type: 'session_verified', platform, ok: null, error: err.message.slice(0, 100) });
    return { verified: null, error: err.message };
  } finally {
    if (page) await browser.closePageHard(page);
    release();
  }
}

module.exports = { setupLogin, verifySession, requeuePendingUberEats };
