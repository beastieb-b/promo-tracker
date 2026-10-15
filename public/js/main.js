// Entry point: wires modules together, loads data, starts live updates and polling.

import { state, subscribe } from './state.js';
import { onAuthRequired } from './api.js';
import { installDelegation, onAction } from './actions.js';
import { initRouter } from './router.js';
import { showToast, clearToasts, flushPendingUndos } from './toast.js';
import { loadMeta, loadQueue, loadLog, refreshAll, quiet } from './data.js';
import { initLive } from './live.js';
import { initOverview } from './overview.js';
import { initQueue } from './queue.js';
import { initResults } from './results.js';
import { initLog } from './log.js';
import { initSettings } from './settings.js';
import { initAccounts } from './accounts.js';
import { initEvents, startEvents, stopEvents } from './events.js';
import { copyText } from './util.js';

const POLL_MS = 30000;
let pollTimer = 0;

function showAuthNotice() {
  if (state.authRequired) return;
  state.authRequired = true;
  clearInterval(pollTimer);
  stopEvents();
  clearToasts();
  document.getElementById('app').hidden = true;
  document.getElementById('auth-notice').hidden = false;
}

function poll() {
  if (state.authRequired || state.restarting || document.hidden) return;
  if (!state.meta) quiet(loadMeta);
  refreshAll();
}

async function start() {
  installDelegation();
  onAction('click', 'copy-code', async (e, el) => {
    const code = el.dataset.code;
    if (!code) return;
    try {
      await copyText(code);
      showToast(`Copied ${code}`, 'success');
    } catch {
      showToast('Copy failed — clipboard blocked', 'error');
    }
  });

  initLive();
  initOverview();
  initQueue();
  initResults();
  initLog();
  initSettings();
  initAccounts();   // restores the stored account choice before anything loads
  initEvents();
  onAuthRequired(showAuthNotice);

  subscribe('section', section => {
    if (state.authRequired) return;
    if (section === 'queue') quiet(loadQueue);
    if (section === 'log') quiet(loadLog);
  });
  initRouter();

  await quiet(loadMeta);
  if (state.authRequired) return;
  await refreshAll();
  if (state.authRequired) return;

  startEvents();
  pollTimer = setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  // Deletes still inside their Undo window are sent before the page goes away.
  window.addEventListener('pagehide', flushPendingUndos);
}

start();
