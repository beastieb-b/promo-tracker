// Apply runs and the daily self-test.

const cfg = require('./config');
const state = require('./state');
const browser = require('./browser');
const promo = require('./promo');
const { requeuePendingUberEats } = require('./login');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Apply run ────────────────────────────────────────────────────────────────
// For each account in turn (one Chrome profile at a time): try up to maxCodes
// of its queued codes (best first, see store.rankQueue) on Postmates, spaced
// CODE_WAIT_MS apart — the spacing also holds between accounts, so the site
// never sees requests faster than with one account. A code Postmates rejects
// for any reason except "Code expired" is retried on Uber Eats. A rate limit
// stops the whole run; a logged-out account stops that account's turn;
// transient errors leave the code queued.
//
// `stores` defaults to the active accounts; `deps` swaps out the browser for tests.
async function runApplyCodes({ maxCodes = cfg.MAX_CODES_PER_RUN, onProgress, stores, deps = {} } = {}) {
  stores = stores || require('./store').active();
  const tagged = require('./accounts').enabled() || stores.length > 1 || stores.some(s => s.account.id !== 'main');
  const d = {
    acquire: browser.acquire,
    getPage: browser.getPage,
    closePage: browser.closePageHard,
    applyCode: promo.applyCode,
    withDeadline: browser.withDeadline,
    screenshot: browser.saveDebugScreenshot,
    sleep,
    now: Date.now,
    attemptMs: cfg.CODE_ATTEMPT_MS,
    waitMs: cfg.CODE_WAIT_MS,
    cooldownMs: cfg.TRANSIENT_COOLDOWN_MS,
    budgetMs: cfg.APPLY_BUDGET_MS * stores.length,
    worstCaseMs: cfg.WORST_CASE_CODE_MS,
    maxTransientFailures: cfg.MAX_TRANSIENT_FAILURES,
    ...deps,
  };

  const release = d.acquire('apply');
  if (!release) return { error: `Browser is busy (${browser.holder() || 'in use'})`, busy: true };
  const startedAt = d.now();
  state.appendLog({ type: 'apply_run_start', ...(tagged ? { accounts: stores.map(s => s.account.id) } : {}) });

  let page = null;
  const results = [];
  let rateLimited = false;
  let stoppedForTime = false;
  let waitBeforeNext = false; // a code was attempted since the last gap

  // One account's turn.
  async function runAccount(s) {
    const acct = s.account;
    const who = tagged ? { account: { id: acct.id, name: acct.name } } : {};
    const progress = (u) => { try { onProgress?.({ ...u, ...who }); } catch {} };
    const log = (e) => state.appendLog({ ...e, ...(tagged ? { account: acct.id } : {}) });
    const record = (r) => results.push({ ...r, ...(tagged ? { account: acct.id } : {}) });
    const replaceLast = (r) => { results[results.length - 1] = { ...r, ...(tagged ? { account: acct.id } : {}) }; };

    // One attempt under its own deadline. A deadline means the page may be
    // frozen, so a fresh one replaces it for the rest of the run.
    const attempt = async (platform, code, label) => {
      // A confirmation pass means the code may already have landed: remember
      // that, so a later "Already applied" is recognized as this cycle's win
      // even if the confirmation itself doesn't finish.
      const onConfirm = () => {
        s.setFlags(code, { confirmPending: true });
        progress({ code, status: 'confirming', platform });
      };
      try {
        const v = await d.withDeadline(d.applyCode(page, code, platform, { onConfirm, accountId: acct.id }), d.attemptMs, label);
        if (v && v.result === 'success' && v.detail === 'Already applied' && s.getFlags(code).confirmPending) {
          return { ...v, detail: 'Applied!' };
        }
        return v;
      } catch (err) {
        if (platform === 'ubereats') await d.screenshot(page, 'ue-error');
        if (/deadline/.test(err.message)) { await d.closePage(page); page = await d.getPage(acct.paths.profile); }
        return { result: 'error', detail: err.message.slice(0, 100) };
      }
    };

    const processed = new Set(s.getProcessed().map(r => r.code));
    const pending = s.getQueueDetails().filter(e => !processed.has(e.code)).slice(0, maxCodes).map(e => e.code);
    if (!pending.length) return;

    if (waitBeforeNext) {
      progress({ code: pending[0], status: 'waiting', waitMs: d.waitMs });
      await d.sleep(d.waitMs);
    }
    if (page) { await d.closePage(page); page = null; }
    page = await d.getPage(acct.paths.profile);
    let ueGaveUp = false; // Uber Eats failed this turn even after pressing Log in

    for (let i = 0; i < pending.length; i++) {
      const code = pending[i];
      const isLast = i === pending.length - 1;

      // Never start a code that might not finish inside the run's budget —
      // the outer deadline would cut it off mid-attempt. It stays queued.
      if (d.now() - startedAt + d.worstCaseMs > d.budgetMs) {
        stoppedForTime = true;
        log({ type: 'apply_stopped_for_time', code, codes_preserved: pending.length - i });
        return;
      }

      progress({ code, status: 'trying' });
      waitBeforeNext = true;

      // Codes held while Uber Eats was logged out come back flagged ueOnly:
      // Postmates already rejected them, so go straight to the Uber Eats retry.
      const flags = s.getFlags(code);
      const parked = !!flags.ueOnly;
      let applyResult = parked
        ? { result: 'rejected', detail: flags.pmDetail || 'Not valid on Postmates' }
        : await attempt('postmates', code, 'Code attempt');

      record({ code, ...applyResult });
      if (!parked) log({ type: 'code_result', code, result: applyResult.result, detail: applyResult.detail });
      progress({ code, status: applyResult.result, detail: applyResult.detail });

      if (applyResult.result === 'ratelimited') {
        // This code and the rest stay queued (markResult is never called).
        rateLimited = true;
        log({ type: 'rate_limited', code, codes_preserved: pending.length - i });
        progress({ code, status: 'rate_limited_stop', preserved: pending.length - i });
        return;
      }

      if (applyResult.result === 'not_logged_in') {
        // Every remaining code for this account would hit the same wall. They
        // stay queued and resume once the login is back (the dashboard shows
        // a banner); other accounts still get their turn.
        log({ type: 'code_deferred', code, reason: 'not_logged_in', note: 'session invalid — skipping the rest of this account' });
        progress({ code, status: 'login_required', detail: applyResult.detail });
        return;
      }

      if (applyResult.result === 'error' || applyResult.result === 'unknown') {
        // Only failures the site gave for this code count toward giving up;
        // our own trouble (box didn't open, deadline) never settles a code.
        const failures = (flags.transientFailures || 0) + (applyResult.codeSpecific ? 1 : 0);
        if (failures < d.maxTransientFailures) {
          // Transient or ambiguous — stays queued for the next run, after a
          // short cooldown so failures don't hammer the site back to back.
          if (applyResult.codeSpecific) s.setFlags(code, { transientFailures: failures });
          log({ type: 'code_deferred', code, reason: applyResult.result, note: `will retry next run (${failures}/${d.maxTransientFailures})` });
          if (!isLast) await d.sleep(d.cooldownMs);
          continue;
        }
        // Same failure run after run: not transient. Settle it as a Postmates
        // rejection, which also gives it its Uber Eats try.
        log({ type: 'code_gave_up', code, failures, detail: applyResult.detail });
        applyResult = { result: 'rejected', detail: `Failed ${failures} runs: ${applyResult.detail.replace(/^Site error \((.*)\)$/, 'site error')}` };
        replaceLast({ code, ...applyResult });
      }

      const ueEligible = applyResult.result === 'rejected' && applyResult.detail !== 'Code expired';
      if (ueEligible && ueGaveUp) {
        // Uber Eats already failed this turn even after pressing Log in: hold
        // the code; it's requeued for Uber Eats once the login is back.
        s.setFlags(code, { pendingUberEats: true, ueOnly: false, pmDetail: applyResult.detail });
        log({ type: 'ubereats_parked', code, note: 'Uber Eats logged out — will retry there after login' });
        applyResult = { result: applyResult.result, detail: `${applyResult.detail} · UberEats: retry after login` };
        replaceLast({ code, ...applyResult });
      } else if (ueEligible) {
        progress({ code, status: 'trying_ubereats' });
        if (parked) s.setFlags(code, { ueOnly: false });
        log({ type: 'ubereats_fallback', code, postmates_detail: applyResult.detail });
        // Two tries: the Uber Eats modal occasionally closes mid-flow, and an
        // error here would forfeit the code's Uber Eats chance for good.
        let ue;
        for (let ueAttempt = 0; ueAttempt < 2; ueAttempt++) {
          ue = await attempt('ubereats', code, 'Uber Eats attempt');
          if (ue.result !== 'error') break;
          if (ueAttempt === 0) {
            log({ type: 'ubereats_fallback_retry', code, error: ue.detail });
            await d.sleep(5000);
          }
        }
        log({ type: 'code_result', code, result: ue.result, detail: ue.detail, platform: 'ubereats' });
        if (['success', 'rejected', 'region_skip'].includes(ue.result)) requeuePendingUberEats(s); // the login works — release held codes
        progress({ code, status: ue.result, detail: ue.detail, platform: 'ubereats' });

        if (ue.result === 'ratelimited') {
          rateLimited = true;
          log({ type: 'rate_limited', code, codes_preserved: pending.length - i, platform: 'ubereats' });
          progress({ code, status: 'rate_limited_stop', preserved: pending.length - i });
          return;
        }
        if (ue.result === 'success' || ue.result === 'region_skip') {
          applyResult = { result: ue.result, detail: `${ue.detail} · UberEats` };
          s.setFlags(code, { appliedOn: 'ubereats' });
        } else {
          // Keep the Postmates rejection, noting the Uber Eats outcome so the
          // Results row tells the whole story.
          const ueNote =
            ue.result === 'rejected'
              ? (ue.detail === applyResult.detail ? 'also on UberEats' : `UberEats: ${ue.detail}`)
              : ue.result === 'not_logged_in'
                ? 'UberEats: retry after login'
                : 'UberEats attempt errored';
          if (ue.result === 'not_logged_in') {
            s.setFlags(code, { pendingUberEats: true, pmDetail: applyResult.detail });
            ueGaveUp = true;
          }
          applyResult = { result: applyResult.result, detail: `${applyResult.detail} · ${ueNote}` };
        }
        replaceLast({ code, ...applyResult });
      }

      // Final verdict (success / rejected / region_skip): record and dequeue.
      s.markResult(code, applyResult.result, applyResult.detail);
      // An expired code is expired for everyone: settle it for the other
      // accounts too instead of spending their attempts on it.
      if (tagged && applyResult.result === 'rejected' && /^Code expired\b/.test(applyResult.detail || '')) {
        for (const other of stores) {
          if (other !== s && other.getQueue().includes(code)) {
            other.markResult(code, 'rejected', `Code expired (seen on ${acct.name})`);
            log({ type: 'expired_shared', code, to: other.account.id });
          }
        }
      }

      if (!isLast) {
        progress({ code, status: 'waiting', waitMs: d.waitMs });
        await d.sleep(d.waitMs);
        waitBeforeNext = false;
      }
    }
  }

  try {
    for (const s of stores) {
      if (rateLimited || stoppedForTime) break;
      await runAccount(s);
    }
    if (!results.length) {
      state.appendLog({ type: 'apply_run_done', reason: 'no_pending_codes' });
      return { applied: 0, results: [], reason: 'No codes in queue' };
    }

    const successes = results.filter(r => r.result === 'success').length;
    state.appendLog({ type: 'apply_run_done', applied: results.length, successes, rateLimited, stoppedForTime });

    // Every attempt came back unknown/error → the site's UI has probably
    // changed. Say so loudly instead of failing silently for days.
    const broken = results.length >= 2 && results.every(r => ['unknown', 'error'].includes(r.result));
    if (broken) {
      state.appendLog({ type: 'detection_health_warning', runs: results.length });
      state.setHealthWarning('All codes returned unknown/error on the last run — the Postmates UI may have changed. Run the self-test in Settings → System Health.');
    }

    return { applied: results.length, results, rateLimited, stoppedForTime, detectionWarning: broken };
  } catch (err) {
    state.appendLog({ type: 'apply_run_error', error: err.message });
    return { error: `Apply run failed: ${err.message}` };
  } finally {
    if (page) await d.closePage(page);
    release();
  }
}

// ── Self-test ────────────────────────────────────────────────────────────────
// End-to-end check: applies a deliberately fake code through the real path.
// A healthy system gets "rejected"; anything else means navigation, input, or
// detection broke.
async function testDetection() {
  const release = browser.acquire('selftest');
  if (!release) return { ok: false, busy: true, error: `Browser is busy (${browser.holder()}) — try again after it finishes` };

  const fakeCode = 'SELFTEST' + Math.floor(1000 + Math.random() * 9000);
  let page = null;
  try {
    // The pipeline check runs on the first account's profile.
    page = await browser.getPage(cfg.BROWSER_PROFILE_DIR);
    const verdict = await browser.withDeadline(promo.applyCode(page, fakeCode, 'postmates', { accountId: 'main' }), cfg.CODE_ATTEMPT_MS, 'Self-test');

    const ok = verdict.result === 'rejected';
    state.appendLog({ type: 'self_test', code: fakeCode, result: verdict.result, ok });
    const existing = state.getHealthWarning();
    if (ok) {
      // Proves the apply pipeline only: retire apply-pipeline banners, never
      // ones about a stale thread or blocked sources.
      if (existing && (existing.source === 'self_test' || existing.source === 'general')) state.clearHealthWarning();
    } else if (verdict.result === 'not_logged_in') {
      // Not a UI problem: the login banner carries the actionable message.
      if (existing && existing.source === 'self_test') state.clearHealthWarning();
    } else {
      state.setHealthWarning(`Self-test failed: expected "rejected" but got "${verdict.result}". The Postmates UI may have changed.`, 'self_test');
    }
    return {
      ok,
      result: verdict.result,
      detail: verdict.detail,
      message: ok
        ? 'Detection pipeline healthy — fake code was correctly rejected.'
        : verdict.result === 'not_logged_in'
          ? 'Postmates is logged out — log in from Settings, then run the test again.'
          : `Expected "rejected" but got "${verdict.result}" — the Postmates UI may have changed.`,
    };
  } catch (err) {
    state.appendLog({ type: 'self_test', code: fakeCode, result: 'crash', ok: false, error: err.message });
    state.setHealthWarning(`Self-test crashed (${err.message.slice(0, 80)}) — run it again from Settings → System Health; if it keeps failing the Postmates UI may have changed.`, 'self_test');
    return { ok: false, error: err.message };
  } finally {
    if (page) await browser.closePageHard(page);
    release();
  }
}

module.exports = { runApplyCodes, testDetection };
