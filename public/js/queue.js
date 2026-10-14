// Queue page: pending codes (in the server's apply order), manual add, remove
// with Undo, and the "Already on Your Account" card.

import { state, subscribe, publish } from './state.js';
import { api, reportError } from './api.js';
import { onAction } from './actions.js';
import { showToast, deferWithUndo } from './toast.js';
import { loadQueue, loadStats, quiet } from './data.js';
import { $, escapeHtml as esc, externalLink, sourceLink, timeAgo, untilText, formatDateTime, plural, setText, show, patchHTML } from './util.js';

export function initQueue() {
  subscribe('queue', renderQueue);
  subscribe('stats', () => { renderQueue(); renderAlreadyApplied(); });
  subscribe('scanStatus', renderQueueHint);

  onAction('submit', 'add-code', addCode);
  onAction('click', 'remove-queued', (e, el) => removeQueued(el.dataset.code));
}

function visibleQueue() {
  return state.queue.filter(item => item && !state.hidden.queue.has(item.code));
}

function renderQueueHint() {
  const hint = $('queue-hint');
  if (!hint) return;
  const when = untilText(state.scanStatus?.nextApplyAt);
  if (visibleQueue().length && when) {
    setText(hint, `Tried automatically on the next apply run (${when}) — or click "Apply Codes" to run now.`);
    hint.hidden = false;
  } else {
    hint.hidden = true;
  }
}

export function renderQueue() {
  const el = $('queue-list');
  if (!el) return;
  if (!state.queueLoaded) return;
  const queue = visibleQueue();
  setText('pending-count', plural(queue.length, 'code'));
  renderQueueHint();

  if (!queue.length) {
    patchHTML(el, '<div class="empty-state">Queue is empty — run a source scan to find codes</div>');
    return;
  }

  // Rendered exactly in the order the server returns: the order the next
  // apply run will try them (priority 1 = next up).
  patchHTML(el, queue.map(item => {
    const code = String(item.code ?? '');
    const link = sourceLink(item);
    const label = item.sourceLabel || (item.sourceKey ? item.sourceKey : 'Manual');
    const source = link
      ? externalLink(link.href, `${label} ↗`, { cls: 'meta-pill source', title: link.title })
      : `<span class="meta-pill${item.sourceKey ? ' source' : ''}">${esc(label)}</span>`;
    const region = item.regionRestricted
      ? `<span class="meta-pill region-restricted" title="${esc(item.regionNote || '')}">📍 maybe ${esc(item.region || 'other area')} — will verify</span>`
      : item.region ? `<span class="meta-pill">📍 ${esc(item.region)}</span>` : '';
    const pills = [
      item.priority === 1 ? '<span class="meta-pill next-up">Next up</span>' : '',
      source,
      item.statusHint ? `<span class="meta-pill">${esc(item.statusHint)}</span>` : '',
      region,
      item.expiresAt ? `<span class="meta-pill">Expires ${esc(item.expiresAt)}</span>` : '',
      item.lastSeenAt ? `<span class="meta-pill" title="${esc(formatDateTime(item.lastSeenAt, { dateStyle: 'medium', timeStyle: 'short' }))}">Seen ${esc(timeAgo(item.lastSeenAt))}</span>` : '',
    ].join('');
    const note = item.statusNote || item.sourceTitle;
    return `<div class="queue-item">
      <div class="queue-main">
        <button type="button" class="queue-code copyable" data-action="copy-code" data-code="${esc(code)}" data-focus-key="qc-${esc(code)}" title="Click to copy">${esc(code)}</button>
        <div class="queue-meta">${pills}</div>
        ${note ? `<div class="queue-note">${esc(note)}</div>` : ''}
      </div>
      <button type="button" class="btn btn-danger btn-sm" data-action="remove-queued" data-code="${esc(code)}" data-focus-key="qr-${esc(code)}" aria-label="Remove ${esc(code)} from the queue">Remove</button>
    </div>`;
  }).join(''));
}

// Codes inside the re-apply skip window: answers "why isn't this code queued?"
function renderAlreadyApplied() {
  const items = Array.isArray(state.stats?.recentlyAppliedList) ? state.stats.recentlyAppliedList : [];
  show('already-applied-card', items.length > 0);
  if (!items.length) return;
  setText('already-applied-count', items.length);
  patchHTML($('already-applied-list'), items.map(item => {
    const when = formatDateTime(item.appliedAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return `<button type="button" class="region-chip" data-action="copy-code" data-code="${esc(item.code)}" data-focus-key="aa-${esc(item.code)}" title="Applied ${esc(when)} — click to copy">
      <span class="region-chip-code">${esc(item.code)}</span>
      <span class="region-chip-loc">✓ applied ${esc(timeAgo(item.appliedAt))}</span>
    </button>`;
  }).join(''));
}

async function addCode(e, form) {
  const input = $('add-code-input');
  const code = (input?.value || '').trim().toUpperCase();
  if (!code) {
    showToast('Type a promo code first', 'error');
    input?.focus();
    return;
  }
  const btn = form.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  try {
    const res = await api('POST', '/api/queue/add', { code });
    if (res.added) {
      showToast(`Added ${res.code || code} to the queue`, 'success');
      input.value = '';
      await Promise.all([quiet(loadQueue), quiet(loadStats)]);
    } else {
      showToast(`${res.code || code} is already in the queue or was already tried`);
    }
  } catch (err) {
    reportError(err, `Couldn't add ${code}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function removeQueued(code) {
  if (!code || state.hidden.queue.has(code)) return;
  state.hidden.queue.add(code);
  publish('queue');
  deferWithUndo({
    message: `Removed ${code} from the queue`,
    onUndo: () => {
      state.hidden.queue.delete(code);
      publish('queue');
    },
    commit: async ({ keepalive }) => {
      try {
        await api('DELETE', `/api/queue/${encodeURIComponent(code)}`, undefined, { keepalive });
        state.queue = state.queue.filter(item => item.code !== code);
        state.hidden.queue.delete(code);
        publish('queue');
        quiet(loadQueue);   // the server renumbers the apply order
        quiet(loadStats);
      } catch (err) {
        state.hidden.queue.delete(code);
        publish('queue');
        reportError(err, `Couldn't remove ${code}`);
      }
    },
  });
}
