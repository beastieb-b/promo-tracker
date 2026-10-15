// Server-sent events: connection status, live updates, and the Quit/Restart
// controls (which need to pause and resume the stream).

import { state, publish } from './state.js';
import { api, reportError, connectEvents } from './api.js';
import { onAction } from './actions.js';
import { showToast } from './toast.js';
import { isVisible } from './router.js';
import { loadMeta, loadStats, loadProcessed, loadQueue, loadLog, refreshAll, refreshScoped, quiet } from './data.js';
import * as live from './live.js';
import { scanFinished, setLastRun } from './overview.js';
import { dailyCheckPhrase } from './settings.js';
import { onAccountsUpdated, setLoginStatus, accountPrefix } from './accounts.js';
import { isMulti, loginKey } from './scope.js';
import { $, plural, platformName } from './util.js';

let stream = null;

export function initEvents() {
  onAction('click', 'restart', restartServer);
  onAction('click', 'quit', quitApp);
}

export function startEvents() {
  stream = connectEvents({ onMessage: handleEvent, onOpen, onDown });
}

export function stopEvents() {
  stream?.close();
}

function setStatus(cls, text) {
  const dot = $('status-dot');
  if (dot) dot.className = `status-dot ${cls}`;
  const label = $('status-text');
  if (label) label.textContent = text;
  state.connection = cls;
}

function onOpen({ reconnect }) {
  const wasStopped = state.stopped;
  state.stopped = false;
  state.restarting = false;
  setStatus('connected', 'Connected');
  if (wasStopped) publish('stopped');
  // Never assume what the server is doing after a (re)connect — a restart
  // ends runs mid-way — re-read it instead.
  if (reconnect || !state.meta) quiet(loadMeta);
  refreshAll();
}

function onDown() {
  if (state.stopped) setStatus('inactive', 'Stopped');
  else if (state.restarting) setStatus('error', 'Restarting…');
  else setStatus('error', 'Reconnecting…');
}

function applyScanStatus(scanStatus, fallback) {
  if (scanStatus && typeof scanStatus === 'object') state.scanStatus = scanStatus;
  else if (fallback) state.scanStatus = { ...(state.scanStatus || {}), ...fallback };
  else return;
  state.scanStatusAt = Date.now();
  publish('scanStatus');
}

let logTimer = 0;
function refreshLogSoon() {
  if (!isVisible('log')) return;
  clearTimeout(logTimer);
  logTimer = setTimeout(() => quiet(loadLog), 600);
}

function handleEvent(d) {
  switch (d.type) {
    case 'connected':
      setStatus('connected', 'Connected');
      break;

    case 'scan_started':
      applyScanStatus(d.scanStatus, { scanRunning: true });
      live.begin('reddit', 'Source scan started…');
      refreshLogSoon();
      break;

    case 'reddit_progress':
      live.redditProgress(d);
      break;

    case 'reddit_done':
      state.runsDone.reddit += 1;
      applyScanStatus(d.scanStatus, { scanRunning: false });
      refreshAll();
      scanFinished(d);
      live.finish('reddit', d.error ? `Source scan failed: ${d.error}` : '✅ Source scan complete', d.error ? 'error' : 'success');
      break;

    case 'apply_started':
      applyScanStatus(d.scanStatus, { applyRunning: true });
      live.begin('apply', 'Code applier started…');
      refreshLogSoon();
      break;

    case 'apply_progress':
      applyScanStatus(d.scanStatus);
      live.applyProgress(d);
      refreshLogSoon();
      break;

    case 'apply_done':
      state.runsDone.apply += 1;
      applyScanStatus(d.scanStatus, { applyRunning: false, applyCurrentCode: null });
      refreshAll();
      applyFinished(d);
      break;

    case 'queue_updated':
      quiet(loadStats);
      if (isVisible('queue')) quiet(loadQueue);
      break;

    case 'processed_updated':
      quiet(loadProcessed);
      quiet(loadStats);
      break;

    case 'health_warning_cleared':
      if (state.stats) {
        state.stats.healthWarning = null;
        publish('stats');
      }
      break;

    case 'self_test_progress':
      state.selfTest = { running: true, result: null };
      publish('selftest');
      break;

    case 'self_test_done': {
      const message = d.message || d.error || d.detail || '';
      state.selfTest = { running: false, result: { ok: Boolean(d.ok), message } };
      publish('selftest');
      showToast(d.ok ? 'Self-test passed — detection pipeline healthy ✅' : `Self-test failed: ${message || 'unknown problem'}`, d.ok ? 'success' : 'error');
      quiet(loadStats);   // health banner is set on fail, cleared on pass
      break;
    }

    // setup_done / login_timeout / session_verified carry `account` and
    // `accountName`; with several accounts on, buttons and toasts are per account.
    case 'setup_done': {
      const target = d.target === 'ubereats' ? 'ubereats' : 'postmates';
      const name = platformName(target);
      const ok = target === 'ubereats' ? d.ueLoggedIn : d.loggedIn;
      const who = accountPrefix(d);
      delete state.login[loginKey(isMulti() ? d.account : null, target)];
      loginWindowClosed();
      // Cookie presence only proves the login saved; the server is verifying
      // the session now (session_verified follows), so show "unverified".
      if (state.stats) {
        setLoginStatus(d.account, target, ok ? null : false);
        publish('stats');
      }
      publish('login');
      showToast(ok ? `${who}${name} login saved — verifying session…` : `${who}Chrome closed — ${name} session not detected`, ok ? 'success' : 'error');
      break;
    }

    case 'login_timeout': {
      const target = d.target === 'ubereats' ? 'ubereats' : 'postmates';
      delete state.login[loginKey(isMulti() ? d.account : null, target)];
      loginWindowClosed();
      publish('login');
      const who = accountPrefix(d);
      showToast(who ? `${who}${platformName(target)} login window closed after 15 minutes` : 'Login window closed after 15 minutes');
      quiet(loadStats);
      break;
    }

    case 'session_verified': {
      const target = d.platform === 'ubereats' ? 'ubereats' : 'postmates';
      const name = platformName(target);
      const who = accountPrefix(d);
      if (d.ok === true || d.ok === false) {
        if (state.stats) {
          setLoginStatus(d.account, target, d.ok);
          publish('stats');
        }
        showToast(d.ok ? `${who}${name} session verified ✅` : `${who}${name} session expired — log in again`, d.ok ? 'success' : 'error');
      } else {
        showToast(`${who}${name} session check inconclusive${d.error ? ` (${d.error})` : ''} — it will be retried by ${dailyCheckPhrase()} or the next apply run`, 'error');
      }
      break;
    }

    case 'settings_updated':
      if (d.settings && typeof d.settings === 'object') {
        const wasMulti = isMulti();
        state.settings = d.settings;
        if (state.stats) {
          state.stats.settings = d.settings;
          if (typeof d.settings.multiAccount === 'boolean') state.stats.multiAccount = d.settings.multiAccount;
        }
        publish('settings');
        // Multiple accounts toggled (here or on another device): everything
        // shown is per account, so re-read it all.
        if (isMulti() !== wasMulti) {
          publish('stats');
          refreshScoped();
        }
      }
      applyScanStatus(d.scanStatus);
      break;

    case 'accounts_updated':
      onAccountsUpdated(d.accounts);
      break;

    case 'error':
      showToast(`Error: ${d.message || 'something went wrong'}`, 'error');
      // The event doesn't say which action failed: release every login button
      // and re-read the run state rather than guessing.
      state.login = {};
      publish('login');
      quiet(loadStats);
      break;

    default:
      break;
  }
}

// A poll taken while the login window was open says the browser is busy with
// it; the window has closed now, so don't keep every login button disabled
// until the next poll.
function loginWindowClosed() {
  if (state.scanStatus?.browserBusy !== 'login') return;
  state.scanStatus = { ...state.scanStatus, browserBusy: null };
  state.scanStatusAt = Date.now();
  publish('scanStatus');
}

function applyFinished(d) {
  if (d.busy) {
    // A scheduled run found the browser in use (login window, self-test):
    // not a failure — the codes wait for the next run.
    showToast(`Apply run skipped — ${d.error || 'the browser is busy'}. Codes wait for the next run.`, 'info');
    setLastRun('apply', 'Skipped (busy)');
    live.finish('apply', 'Skipped — browser busy', 'muted');
    return;
  }
  if (d.error) {
    showToast(`Apply failed: ${d.error}`, 'error');
    setLastRun('apply', 'Error', true);
    live.finish('apply', `Apply failed: ${d.error}`, 'error');
    return;
  }
  const applied = Number(d.applied) || 0;
  if (!applied) {
    // Nothing was tried — don't say "0 worked".
    showToast('Queue is empty — nothing to apply. Run "Check Sources" to find codes.');
    setLastRun('apply', 'Nothing queued');
    live.finish('apply', 'Nothing to apply', 'muted');
    return;
  }
  const successes = (Array.isArray(d.results) ? d.results : []).filter(r => r.result === 'success').length;
  let msg = successes ? `${plural(successes, 'code')} worked! 🎉` : `Applied ${plural(applied, 'code')} — none worked this run`;
  if (d.rateLimited) msg += ' · Rate limited, remaining codes saved for next run';
  else if (d.stoppedForTime) msg += ' · Stopped at the time limit, remaining codes saved for next run';
  showToast(msg, successes ? 'success' : 'info');
  setLastRun('apply', successes ? `✅ ${successes} worked` : d.rateLimited ? '⏳ Rate limited' : `✅ ${applied} tried`);
  if (d.rateLimited) live.finish('apply', '⏳ Rate limited — remaining codes saved for next run', 'warn');
  else if (successes) live.finish('apply', `✅ ${plural(successes, 'code')} worked!`, 'success');
  else live.finish('apply', `Run complete — ${applied} tried`, 'muted');
}

/* ── Quit / Restart ──────────────────────────────────────────────────────── */

const QUIT_MESSAGES = {
  launchd: 'Stopped. It starts again the next time you log in to this Mac, or run "npm run restart".',
  process: 'Stopped. Relaunch it with the Promo Tracker launcher.',
};

async function quitApp() {
  if (!window.confirm('Stop Promo Tracker?\n\nScanning and applying codes stop until it is started again.')) return;
  let res;
  try {
    res = await api('POST', '/api/quit');
  } catch (err) {
    reportError(err, "Couldn't stop Promo Tracker");
    return;
  }
  state.stopped = res.mode === 'launchd' ? 'launchd' : 'process';
  setStatus('inactive', 'Stopped');
  publish('stopped');
  showToast(QUIT_MESSAGES[state.stopped], 'info', { duration: 12000 });
}

async function restartServer() {
  if (!window.confirm('Restart Promo Tracker?\n\nIt will be back in about 15 seconds.')) return;
  try {
    await api('POST', '/api/restart');
  } catch (err) {
    reportError(err, "Couldn't restart Promo Tracker");
    return;
  }
  state.restarting = true;
  stream?.pause();
  setStatus('error', 'Restarting…');
  showToast('Restarting — back in about 15 seconds…', 'info', { duration: 8000 });
  setTimeout(() => waitForServer(0), 12000);
}

// Poll /api/meta until the restarted server answers, then reconnect.
async function waitForServer(attempt) {
  if (state.authRequired) return;
  try {
    await loadMeta();
  } catch {
    if (state.authRequired) return;
    if (attempt >= 40) {
      state.restarting = false;
      setStatus('error', 'Not responding');
      showToast("Promo Tracker hasn't come back after 2 minutes — check the Mac it runs on.", 'error', { duration: 12000 });
      stream?.resume();
      return;
    }
    setTimeout(() => waitForServer(attempt + 1), 3000);
    return;
  }
  stream?.resume();   // onOpen re-reads stats + results
  showToast('Promo Tracker is back', 'success');
}
