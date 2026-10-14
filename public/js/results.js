// Results page: every code tried, newest first, with filter/search, retry,
// region reclassification and delete with Undo.

import { state, subscribe, publish } from './state.js';
import { api, reportError } from './api.js';
import { onAction } from './actions.js';
import { showToast, deferWithUndo } from './toast.js';
import { loadProcessed, loadStats, loadQueue, quiet } from './data.js';
import { isVisible } from './router.js';
import {
  $, escapeHtml as esc, cssToken, externalLink, sourceLink, timeAgo, formatDateTime,
  platformName, patchHTML, setText, resultIcon, resultLabel,
} from './util.js';

const FILTERS = ['all', 'success', 'rejected', 'region_skip'];
const FILTER_NAMES = { all: '', success: 'success ', rejected: 'rejected ', region_skip: 'region-locked ' };

export function initResults() {
  subscribe('processed', renderResults);

  onAction('click', 'filter', (e, el) => setFilter(el.dataset.filter));
  onAction('input', 'search-results', (e, el) => {
    state.search = (el.value || '').trim().toUpperCase();
    renderResults();
  });
  onAction('click', 'delete-result', (e, el) => deleteResult(el.dataset.code));
  onAction('click', 'retry-result', (e, el) => requeueResult(el.dataset.code, el));
  onAction('click', 'reclassify', (e, el) => reclassify(el.dataset.code, el.dataset.result, el));
}

function setFilter(filter) {
  state.filter = FILTERS.includes(filter) ? filter : 'all';
  document.querySelectorAll('.filter-btn[data-filter]').forEach(btn => {
    const on = btn.dataset.filter === state.filter;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
  });
  renderResults();
}

function visible() {
  return state.processed.filter(r => r && !state.hidden.processed.has(r.code));
}

export function renderResults() {
  const tbody = $('results-tbody');
  if (!tbody) return;
  const all = visible();

  const counts = { all: all.length, success: 0, rejected: 0, region_skip: 0 };
  for (const r of all) if (counts[r.result] !== undefined) counts[r.result] += 1;
  for (const key of FILTERS) setText(`fc-${key}`, counts[key]);

  let rows = state.filter === 'all' ? all : all.filter(r => r.result === state.filter);
  if (state.search) rows = rows.filter(r => String(r.code || '').toUpperCase().includes(state.search));

  if (!rows.length) {
    const msg = state.search
      ? `No results matching "${esc(state.search)}"`
      : `No ${FILTER_NAMES[state.filter] || ''}results yet`;
    patchHTML(tbody, `<tr><td colspan="6" class="empty-state">${msg}</td></tr>`);
    return;
  }
  patchHTML(tbody, rows.slice().reverse().map(rowHtml).join(''));
}

function rowHtml(r) {
  const code = String(r.code ?? '');
  const c = esc(code);
  const link = sourceLink(r);
  const label = r.sourceLabel || 'Manual';
  const sourceHtml = link ? externalLink(link.href, `${label} ↗`, { title: link.title }) : esc(label);
  const onUE = r.platform === 'ubereats';
  const counts = r.result === 'success' || r.result === 'region_skip';

  const amount = counts && r.amount ? `<span class="result-amount">${esc(r.amount)}</span>` : '';
  const platform = onUE ? '<span class="platform-tag">Uber Eats</span>' : '';
  // The platform is shown as a tag, so drop a trailing "· Uber Eats" from the detail.
  const detail = String(r.detail || '—').replace(/\s*·\s*Uber\s?Eats\s*$/i, '') || '—';
  const regionNote = r.result === 'region_skip'
    ? `<div class="result-submeta region-note">✓ Applied on ${esc(platformName(r.platform))} · not counted toward total</div>`
    : '';

  const actions = [];
  if (r.result === 'success') {
    actions.push(`<button type="button" class="result-action-btn" data-action="reclassify" data-result="region_skip" data-code="${c}" data-focus-key="rl-${c}" title="Mark region-locked (doesn't count toward total)" aria-label="Mark ${c} as region-locked">📍</button>`);
  } else if (r.result === 'region_skip') {
    actions.push(`<button type="button" class="result-action-btn" data-action="reclassify" data-result="success" data-code="${c}" data-focus-key="rs-${c}" title="Count as savings (it works here)" aria-label="Count ${c} as savings">✓$</button>`);
  } else if (['rejected', 'error', 'unknown'].includes(r.result)) {
    actions.push(`<button type="button" class="result-retry-btn" data-action="retry-result" data-code="${c}" data-focus-key="rr-${c}" title="Add back to the queue to try again" aria-label="Retry ${c}">↻<span class="btn-label"> Retry</span></button>`);
  }
  actions.push(`<button type="button" class="result-delete-btn" data-action="delete-result" data-code="${c}" data-focus-key="rd-${c}" title="Delete" aria-label="Delete the result for ${c}">✕</button>`);

  return `<tr class="result-row">
    <td class="result-code" data-label="Code"><div class="result-code-stack"><button type="button" class="result-code-value copyable" data-action="copy-code" data-code="${c}" data-focus-key="rc-${c}" title="Click to copy">${c}</button></div></td>
    <td class="result-source" data-label="Source"><div class="result-source-label">${sourceHtml}</div><div class="result-submeta">${esc(r.statusHint || r.sourceTitle || '—')}</div></td>
    <td data-label="Result"><span class="result-badge ${cssToken(r.result)}">${resultIcon(r.result)} ${esc(resultLabel(r.result))}</span>${amount}${platform}</td>
    <td class="result-detail" data-label="Details"><div>${esc(detail)}</div>${regionNote}</td>
    <td class="result-when" data-label="When" title="${esc(formatDateTime(r.ts, { dateStyle: 'medium', timeStyle: 'short' }))}">${esc(timeAgo(r.ts))}</td>
    <td class="result-delete-cell" data-label="Actions">${actions.join('')}</td>
  </tr>`;
}

function deleteResult(code) {
  if (!code || state.hidden.processed.has(code)) return;
  state.hidden.processed.add(code);
  publish('processed');
  deferWithUndo({
    message: `Deleted ${code}`,
    onUndo: () => {
      state.hidden.processed.delete(code);
      publish('processed');
    },
    commit: async ({ keepalive }) => {
      try {
        const res = await api('DELETE', `/api/processed/${encodeURIComponent(code)}`, undefined, { keepalive });
        if (!res.deleted) showToast(`${code} was already gone`);
        state.processed = state.processed.filter(r => r.code !== code);
        state.hidden.processed.delete(code);
        publish('processed');
        quiet(loadStats);
      } catch (err) {
        state.hidden.processed.delete(code);
        publish('processed');
        reportError(err, `Couldn't delete ${code}`);
      }
    },
  });
}

async function requeueResult(code, btn) {
  if (!code) return;
  btn.disabled = true;
  try {
    await api('POST', `/api/processed/${encodeURIComponent(code)}/requeue`);
    showToast(`${code} added back to the queue — it will be retried on the next run`, 'success');
    await Promise.all([quiet(loadProcessed), quiet(loadStats), isVisible('queue') ? quiet(loadQueue) : null]);
  } catch (err) {
    reportError(err, `Couldn't re-queue ${code}`);
  } finally {
    btn.disabled = false;
  }
}

async function reclassify(code, result, btn) {
  if (!code || (result !== 'success' && result !== 'region_skip')) return;
  btn.disabled = true;
  try {
    const res = await api('POST', `/api/processed/${encodeURIComponent(code)}/reclassify`, { result });
    if (!res.updated) {
      showToast(`${code} has no applied result to change`, 'error');
      return;
    }
    showToast(result === 'region_skip'
      ? `${code} marked region-locked — it won't count toward your total`
      : `${code} now counts toward your total`, 'success');
    await Promise.all([quiet(loadProcessed), quiet(loadStats)]);
  } catch (err) {
    reportError(err, `Couldn't update ${code}`);
  } finally {
    btn.disabled = false;
  }
}
