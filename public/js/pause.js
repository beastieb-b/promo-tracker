// Pause / resume: the sidebar button, the banner, and the "how long" dialog.
// The server's scanStatus.pause ({ paused, pausedAt, until }) is the truth.

import { state, subscribe, publish } from './state.js';
import { api, reportError } from './api.js';
import { onAction } from './actions.js';
import { showToast } from './toast.js';
import { $, setText, show, formatDateTime } from './util.js';

let sending = false;

export function initPause() {
  subscribe('scanStatus', renderPause);
  subscribe('stats', renderPause);
  subscribe('stopped', renderPause);
  onAction('click', 'pause-open', openDialog);
  onAction('click', 'pause-for', (e, el) => pauseFor(el.dataset.minutes));
  onAction('click', 'resume', resume);
}

export const pauseInfo = () => state.scanStatus?.pause || { paused: false, until: null };
export const isPaused = () => Boolean(pauseInfo().paused) && !state.stopped;

/** "until 3:45 PM", "until Tue 9:00 AM", or "until you resume". */
export function untilLabel(until) {
  if (!until) return 'until you resume';
  const day = (v) => formatDateTime(v, { year: 'numeric', month: 'numeric', day: 'numeric' });
  const sameDay = day(until) === day(new Date());
  return `until ${formatDateTime(until, sameDay
    ? { hour: 'numeric', minute: '2-digit' }
    : { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}

function applyStatus(scanStatus) {
  if (!scanStatus || typeof scanStatus !== 'object') return;
  state.scanStatus = scanStatus;
  state.scanStatusAt = Date.now();
  publish('scanStatus');
}

function renderPause() {
  const paused = isPaused();
  const { until } = pauseInfo();
  const s = state.scanStatus || {};

  const btn = $('btn-pause');
  if (btn) {
    btn.dataset.action = paused ? 'resume' : 'pause-open';
    btn.classList.toggle('is-paused', paused);
    btn.setAttribute('aria-haspopup', paused ? 'false' : 'dialog');
    setText(btn.querySelector('.pause-icon'), paused ? '▶' : '⏸');
    setText(btn.querySelector('.btn-text'), paused ? 'Resume' : 'Pause');
    btn.disabled = sending || Boolean(state.stopped) || !state.scanStatus;
  }
  setText('pause-label', paused ? `Paused ${untilLabel(until)}` : '');

  show('pause-banner', paused);
  if (!paused) return;
  setText('pause-banner-title', `Paused ${untilLabel(until)}`);
  setText('pause-banner-msg',
    s.applyRunning ? `Stopping the apply run after ${s.applyCurrentCode || 'the current code'}…`
      : s.scanRunning ? 'Finishing the current source scan, then holding…'
        : until
          ? 'No scans or code attempts until then, and Chrome stays closed. Anything missed runs when it resumes.'
          : 'No scans or code attempts, and Chrome stays closed. Anything missed runs when you resume.');
}

function openDialog() {
  const dialog = $('pause-dialog');
  if (!dialog || dialog.open) return;
  dialog.showModal();
}

async function pauseFor(raw) {
  $('pause-dialog')?.close();
  if (sending) return;
  const minutes = raw ? Number(raw) : null;
  sending = true;
  renderPause();
  try {
    const res = await api('POST', '/api/pause', { minutes });
    applyStatus(res.scanStatus);
    const s = res.scanStatus || {};
    const note = s.applyRunning ? ' — the apply run stops after its current code'
      : s.scanRunning ? ' — the current scan finishes first' : '';
    showToast(`Paused ${untilLabel(res.until)}${note}`, 'info');
  } catch (err) {
    reportError(err, "Couldn't pause");
  } finally {
    sending = false;
    renderPause();
  }
}

async function resume() {
  if (sending) return;
  sending = true;
  renderPause();
  try {
    const res = await api('POST', '/api/resume');
    applyStatus(res.scanStatus);
    showToast(res.catchingUp ? 'Resumed — catching up on what the pause skipped' : 'Resumed', 'success');
  } catch (err) {
    reportError(err, "Couldn't resume");
  } finally {
    sending = false;
    renderPause();
  }
}
