// "Live Progress" card on the dashboard: a running log of the current scan /
// apply run, fed by SSE events.

import { onAction } from './actions.js';
import { $, escapeHtml as esc, plural, formatWait } from './util.js';

const active = new Set();   // run types in progress: 'reddit' | 'apply'

export function initLive() {
  onAction('click', 'dismiss-live', hide);
}

function card() { return $('live-status-card'); }

function setHeader(summaryHtml) {
  const header = $('live-header');
  if (!header) return;
  header.innerHTML = summaryHtml === null
    ? '<h3>Live Progress</h3><span class="spinner"></span>'
    : `<h3>Live Progress</h3><div class="live-header-right">${summaryHtml}<button type="button" class="live-dismiss" data-action="dismiss-live" title="Dismiss" aria-label="Dismiss live progress">×</button></div>`;
}

/** Start (or join) a run. A fresh card only when nothing else is running. */
export function begin(type, text) {
  if (active.has(type)) return;
  if (!active.size) {
    const log = $('live-log');
    if (log) log.textContent = '';
  }
  active.add(type);
  setHeader(null);
  const c = card();
  if (c) c.hidden = false;
  if (text) line(text);
}

export function line(text, cls = '') {
  const c = card();
  const log = $('live-log');
  if (!c || !log) return;
  c.hidden = false;
  const row = document.createElement('div');
  row.className = `live-log-line${cls ? ` ${cls}` : ''}`;
  const ts = document.createElement('span');
  ts.className = 'live-log-ts';
  ts.textContent = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const msg = document.createElement('span');
  msg.textContent = text;
  row.append(ts, msg);
  log.appendChild(row);
  while (log.childElementCount > 300) log.firstElementChild.remove();
  log.scrollTop = log.scrollHeight;
}

/**
 * End a run. kind: 'success' | 'warn' | 'muted' | 'error'.
 * If another run is still going, the summary becomes a log line instead.
 */
export function finish(type, text, kind = 'success') {
  if (!active.has(type) && card()?.hidden) return;
  active.delete(type);
  if (active.size) {
    line(text, kind === 'success' ? 'success' : kind === 'muted' ? '' : kind === 'error' ? 'error' : 'waiting');
    return;
  }
  setHeader(`<span class="live-summary ${esc(kind)}">${esc(text)}</span>`);
}

export function hide() {
  active.clear();
  const c = card();
  if (c) c.hidden = true;
}

/* ── Event → line ────────────────────────────────────────────────────────── */

export function redditProgress(d) {
  begin('reddit');
  const src = d.source || 'Source';
  const msgs = {
    detecting: `🔍 ${src}: detecting thread…`,
    new_thread: `🆕 ${src}: new thread ${d.threadId ?? ''}`,
    fetching: `💬 ${src}: fetching comments${d.threadId ? ` (${d.threadId})` : ''}…`,
    fallback: `↩ ${src}: new thread empty, checking previous (${d.threadId ?? ''})…`,
    source_item: `• ${src}: ${d.message ?? ''}`,
    skipped: `⏭ ${src}: skipped${d.message ? ` — ${d.message}` : ''}`,
    done: `✅ ${src}: ${d.commentsScanned ? `${d.commentsScanned} comments · ` : ''}${plural(Number(d.newCodes) || 0, 'candidate')}${d.queued !== undefined ? ` · ${d.queued} queued` : ''}`,
    error: `❌ ${src}: ${d.message ?? 'error'}`,
  };
  const cls = { done: 'success', error: 'error', source_item: 'waiting', skipped: 'waiting' }[d.step] || '';
  line(msgs[d.step] || `${src}: ${d.step}`, cls);
}

export function applyProgress(d) {
  begin('apply');
  const code = d.code ?? '';
  const where = d.platform === 'ubereats' ? ' on Uber Eats' : '';
  let msg;
  let cls = '';
  switch (d.status) {
    case 'trying': msg = `→ Trying ${code}…`; break;
    case 'confirming': msg = `Double-checking ${code}…`; break;
    case 'trying_ubereats': msg = `↪ ${code} rejected on Postmates — trying Uber Eats…`; cls = 'waiting'; break;
    case 'success': msg = `✅ ${code} — SUCCESS${where}${d.detail ? `: ${d.detail}` : ''}`; cls = 'success'; break;
    case 'rejected': msg = `❌ ${code} — rejected${where}${d.detail ? ` (${d.detail})` : ''}`; cls = 'error'; break;
    case 'region_skip': msg = `📍 ${code} — region-locked${where} (${d.detail || 'other area'})`; cls = 'waiting'; break;
    case 'ratelimited': msg = '⏳ Rate limited — stopping run'; cls = 'waiting'; break;
    case 'rate_limited_stop': {
      const n = Number(d.preserved) || 0;
      msg = `⏳ Rate limited — ${plural(n, 'code')} saved in queue for next run`;
      cls = 'waiting';
      break;
    }
    case 'waiting': msg = `   Waiting ${formatWait(d.waitMs) || 'a moment'} before the next code…`; cls = 'waiting'; break;
    case 'login_required': msg = `🔑 Login required${where} — open Settings to sign in`; cls = 'error'; break;
    case 'error': msg = `⚠️ ${code} — error${d.detail ? `: ${d.detail}` : ''}`; cls = 'error'; break;
    case 'unknown': msg = `❓ ${code} — result unclear${d.detail ? ` (${d.detail})` : ''}`; cls = 'waiting'; break;
    default: msg = `${code}: ${d.status}`;
  }
  line(msg, cls);
}
