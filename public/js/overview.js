// Dashboard: stats, scan status, banners, setup checklist, savings, sources,
// plus the sidebar run buttons (whose state follows the server's scanStatus).

import { state, subscribe, publish } from './state.js';
import { api, reportError } from './api.js';
import { onAction } from './actions.js';
import { showToast } from './toast.js';
import { go, isVisible } from './router.js';
import { loadStats, quiet } from './data.js';
import * as live from './live.js';
import { renderLoginButtons } from './accounts.js';
import { isMulti, accountList, accountTag, statsView, viewOf, rowKey, rowFocus } from './scope.js';
import {
  $, escapeHtml as esc, cssToken, safeUrl, externalLink, timeAgo, formatDuration, untilText,
  formatInterval, formatMoney, formatMonth, formatDateTime, plural, setText, show, patchHTML,
  resultIcon, resultLabel, platformName,
} from './util.js';

export function initOverview() {
  subscribe('stats', renderOverview);
  subscribe('scanStatus', () => { renderScanStatus(); syncRunButtons(); });
  subscribe('processed', renderActivity);
  subscribe('stopped', renderScanStatus);
  subscribe('section', renderSetup);

  onAction('click', 'run-reddit', () => startRun('reddit'));
  onAction('click', 'run-apply', () => startRun('apply'));
  onAction('click', 'dismiss-health', dismissHealthWarning);
  onAction('click', 'toggle-step', (e, el) => toggleStep(el.dataset.step));
  onAction('click', 'focus-home-region', e => {
    e.preventDefault();
    go('settings', { focus: '#home-region-input' });
  });
}

export function renderOverview() {
  const st = state.stats;
  if (!st) return;

  setText('stat-success', st.successCount ?? 0);
  setText('stat-queue', st.queueCount ?? 0);
  setText('stat-tried', st.totalTried ?? 0);
  renderSavings(st);

  const badge = $('queue-badge');
  if (badge) {
    setText(badge, st.queueCount || '');
    badge.hidden = !st.queueCount;
  }

  renderThreadBadge(st);
  renderThreadFreshness(st.threadFreshness);
  renderSavingsGraph(st.monthlySavings, st.currentMonth);
  renderSuccessList(st.successList);
  renderRegionLocked(st.regionLockedList);
  renderMonitoredSources(st.monitoredSources);
  renderBanners(st);
  renderSetup();
  renderScanStatus();
  syncRunButtons();
  renderActivity();
}

/* ── Savings hero ────────────────────────────────────────────────────────── */

function renderSavings(st) {
  const saved = Number(st.savedThisMonth) || 0;
  setText('stat-saved', formatMoney(saved));

  const n = st.successCount ?? 0;
  const parts = [esc(n ? `across ${plural(n, 'code')}` : 'no new codes yet')];
  const already = st.alreadyOnAccountCount ?? 0;
  if (already) parts.push(esc(`${plural(already, 'earlier code')} still on the account`));
  const locked = st.regionLockedCount ?? 0;
  if (locked) parts.push(esc(`${locked} region-locked excluded`));
  const ue = Number(st.savedOnUberEats) || 0;
  if (ue > 0) parts.push(esc(`${formatMoney(ue)} on Uber Eats`));
  const last = st.savedLastMonth;
  if (typeof last === 'number' && (saved || last)) {
    const delta = saved - last;
    const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '·';
    const cls = delta > 0 ? 'delta-up' : delta < 0 ? 'delta-down' : 'delta-flat';
    parts.push(`<span class="${cls}">${arrow} ${esc(formatMoney(Math.abs(delta)))} vs last month</span>`);
  }
  if (typeof st.savedLifetime === 'number' && st.savedLifetime > 0) {
    parts.push(`<span class="delta-flat">${esc(formatMoney(st.savedLifetime))} all-time</span>`);
  }
  patchHTML($('stat-saved-sub'), parts.join(' · '));
}

/* ── Scan status bar + run buttons ───────────────────────────────────────── */

function renderScanStatus() {
  const dot = $('scan-dot');
  const label = $('scan-label');
  const meta = $('scan-meta');
  if (!dot || !label || !meta) return;
  const s = state.scanStatus;
  const set = (dotCls, labelHtml, metaHtml = '') => {
    dot.className = `scan-dot ${dotCls}`;
    patchHTML(label, labelHtml);
    patchHTML(meta, metaHtml);
  };

  if (state.stopped) {
    const how = state.stopped === 'launchd'
      ? 'It starts again the next time you log in to this Mac, or run <code>npm run restart</code>.'
      : 'Relaunch it with the Promo Tracker launcher.';
    set('inactive', 'Stopped', `<span class="scan-meta-item">${how}</span>`);
    return;
  }
  if (!s || !s.active) {
    set('inactive', esc(state.stats ? 'Auto-scan not started' : 'Loading…'));
    return;
  }

  // A run in progress takes priority — and survives page reloads, since it
  // comes from the server's scanStatus (stats poll or SSE).
  if (s.applyRunning) {
    const code = s.applyCurrentCode ? ` · trying ${esc(s.applyCurrentCode)}` : '';
    set('applying', `<span class="spinner spinner-inline"></span>Applying codes…${code}`,
      s.applyStartedAt ? `<span class="scan-meta-item">Started <strong>${esc(timeAgo(s.applyStartedAt))}</strong></span>` : '');
    return;
  }
  if (s.scanRunning) {
    set('applying', '<span class="spinner spinner-inline"></span>Checking sources…',
      s.scanStartedAt ? `<span class="scan-meta-item">Started <strong>${esc(timeAgo(s.scanStartedAt))}</strong></span>` : '');
    return;
  }

  // Staleness watchdog: last successful scan far older than the interval means
  // the service is stalled or the Mac was asleep (heartbeat survives restarts).
  const hb = state.stats?.heartbeat?.scan || s.lastScanAt;
  const lastScan = hb ? new Date(hb) : null;
  const staleMs = Math.max(90 * 60000, (Number(s.intervalHours) || 2) * 3600000 * 3);
  if (lastScan && !Number.isNaN(lastScan.getTime()) && Date.now() - lastScan.getTime() > staleMs) {
    set('error', '⚠️ Scans stalled',
      `<span class="scan-meta-item danger">No successful scan in ${esc(formatDuration(Date.now() - lastScan.getTime()))} — the service may be down or the Mac asleep</span>`);
    return;
  }
  if (s.lastScanError) {
    set('error', 'Scan error', `<span class="scan-meta-item danger">${esc(s.lastScanError)}</span>`);
    return;
  }

  const applyEvery = state.settings.applyIntervalHours ?? s.applyIntervalHours;
  const parts = [
    `<span class="scan-meta-item">Scan every <strong>${esc(formatInterval(s.intervalHours))}</strong></span>`,
    `<span class="scan-meta-item" title="New codes trigger an apply run right away when rate limits allow">Apply every <strong>${esc(formatInterval(applyEvery))}</strong> + new codes instantly</span>`,
  ];
  const nextScan = untilText(s.nextScanAt);
  if (nextScan) parts.push(`<span class="scan-meta-item">Next scan <strong>${esc(nextScan)}</strong></span>`);
  const nextApply = untilText(s.nextApplyAt);
  if (nextApply) parts.push(`<span class="scan-meta-item">Next apply <strong>${esc(nextApply)}</strong></span>`);
  set('active', 'Automation ON', parts.join(''));
}

const RUNS = {
  reddit: { btn: 'btn-reddit', flag: 'scanRunning', idle: 'Check Sources', busy: 'Checking…', path: '/api/run/reddit', what: 'source scan' },
  apply: { btn: 'btn-apply', flag: 'applyRunning', idle: 'Apply Codes', busy: 'Applying…', path: '/api/run/apply', what: 'code applier' },
};

/** Buttons are disabled exactly while the server reports that run in progress. */
export function syncRunButtons() {
  for (const [which, run] of Object.entries(RUNS)) {
    const btn = $(run.btn);
    if (!btn) continue;
    const busy = Boolean(state.scanStatus?.[run.flag]) || state.starting[which];
    btn.disabled = busy;
    btn.setAttribute('aria-busy', String(busy));
    setText(btn.querySelector('.btn-text'), busy ? run.busy : run.idle);
  }
  for (const which of Object.keys(RUNS)) {
    const el = $(`last-${which}-run`);
    const last = state.lastRun[which];
    if (!el) continue;
    setText(el, last?.text || '');
    el.classList.toggle('error', Boolean(last?.error));
  }
}

export function setLastRun(which, text, error = false) {
  state.lastRun[which] = { text, error };
  syncRunButtons();
}

async function startRun(which) {
  const run = RUNS[which];
  if (state.starting[which]) return;
  state.starting[which] = true;
  syncRunButtons();
  // A short run can finish (SSE *_done) before this request even resolves, so
  // open the progress card first and only mirror "running" if no done event
  // has arrived since the click.
  const doneBefore = state.runsDone[which];
  live.begin(which, which === 'reddit' ? 'Starting source scan…' : 'Starting code applier…');
  try {
    await api('POST', run.path);
    if (state.runsDone[which] === doneBefore) {
      state.scanStatus = { ...(state.scanStatus || {}), [run.flag]: true };
      state.scanStatusAt = Date.now();
    }
  } catch (err) {
    live.finish(which, err.busy ? err.message : `Couldn't start the ${run.what}`, err.busy ? 'muted' : 'error');
    reportError(err, `Couldn't start the ${run.what}`);
  } finally {
    state.starting[which] = false;
    publish('scanStatus');
    quiet(loadStats);
  }
}

/* ── Banners ─────────────────────────────────────────────────────────────── */

function renderBanners(st) {
  const w = st.healthWarning;
  if (w && w.message) {
    setText('health-banner-msg', w.ts ? `${w.message} (${timeAgo(w.ts)})` : w.message);
    show('health-banner', true);
  } else {
    show('health-banner', false);
  }
  // Several accounts: one banner per account that's logged out (below).
  const multi = isMulti();
  show('login-banner', !multi && st.loggedIn === false);
  show('ue-login-banner', !multi && st.ueLoggedIn === false);
  renderAccountBanners(multi);
}

function renderAccountBanners(multi) {
  const el = $('account-login-banners');
  if (!el) return;
  const html = (multi ? accountList() : []).map(a => {
    const out = [a.loggedIn === false ? 'postmates' : null, a.ueLoggedIn === false ? 'ubereats' : null].filter(Boolean);
    if (!out.length) return '';
    const id = esc(a.id);
    const what = out.length === 2
      ? 'Postmates and Uber Eats sessions expired'
      : `${platformName(out[0])} session expired`;
    const buttons = out.map(target => `<button type="button" class="btn btn-secondary btn-sm" data-action="login" data-target="${target}" data-account="${id}" data-variant="${out.length === 2 ? 'banner-platform' : 'banner'}" data-focus-key="lb-${id}-${target}">🔐 Log in</button>`).join('');
    return `<div class="health-banner login-warning">
      <span class="health-banner-icon" aria-hidden="true">🔑</span>
      <div class="health-banner-text">
        <strong>${esc(a.name || a.id)}: ${esc(what)}</strong>
        <span>Codes can't be applied for this account until you sign in. One click opens Chrome on the Mac running Promo Tracker.</span>
      </div>
      <div class="banner-actions">${buttons}</div>
    </div>`;
  }).join('');
  if (patchHTML(el, html)) renderLoginButtons();
  el.hidden = !html;
}

async function dismissHealthWarning() {
  show('health-banner', false);
  try {
    await api('DELETE', '/api/health-warning');
    if (state.stats) state.stats.healthWarning = null;
  } catch (err) {
    show('health-banner', Boolean(state.stats?.healthWarning));
    reportError(err, "Couldn't dismiss the warning");
  }
}

/* ── Setup checklist (rendered here and on the Settings page) ────────────── */

export function renderSetup() {
  const setup = state.stats?.setup;
  if (!setup || !Array.isArray(setup.steps)) return;

  // Settings shows its own copy of the steps, so don't list them twice there.
  show('setup-checklist', !setup.allRequiredDone && !isVisible('settings'));
  const pending = setup.steps.filter(s => s.required && !s.done).length;
  setText('setup-subtitle', setup.allRequiredDone ? 'All set!' : `${plural(pending, 'step')} remaining`);
  patchHTML($('setup-steps'), stepsHtml(setup.steps));

  show('settings-setup-checklist', !setup.allDone);
  patchHTML($('settings-setup-steps'), stepsHtml(setup.steps));
}

function stepsHtml(steps) {
  return steps.map(step => {
    const id = String(step.id || '');
    const open = !step.done && state.openSteps.has(id);
    const cls = ['setup-step', step.done ? 'done' : 'pending', !step.done && !step.required ? 'optional' : '', open ? 'open' : '']
      .filter(Boolean).join(' ');
    const icon = step.done ? '✅' : step.required ? '⚠️' : '○';
    const optional = !step.required ? ' <span class="step-optional-tag">Optional</span>' : '';
    const body = `<span class="step-icon" aria-hidden="true">${icon}</span>
        <span class="step-body">
          <span class="step-label">${esc(step.label)}${optional}</span>
          <span class="step-desc">${step.done ? 'Complete' : esc(step.description)}</span>
        </span>`;

    if (step.done) {
      return `<div class="${cls}"><div class="setup-step-header">${body}</div></div>`;
    }
    if (id === 'home-region') {
      // Fixed in-app: jump to Settings and focus the field.
      return `<div class="${cls}"><a class="setup-step-header" href="#settings" data-action="focus-home-region" data-focus-key="step-${esc(id)}">${body}<span class="step-chevron" aria-hidden="true">›</span></a></div>`;
    }
    const detail = step.command || step.hint
      ? `<div class="setup-step-detail">
          ${step.command ? `<div class="step-command">${esc(step.command)}</div>` : ''}
          ${step.hint ? `<div class="step-hint">${esc(step.hint)}</div>` : ''}
        </div>`
      : '';
    return `<div class="${cls}">
      <button type="button" class="setup-step-header" data-action="toggle-step" data-step="${esc(id)}" data-focus-key="step-${esc(id)}" aria-expanded="${open}">${body}<span class="step-chevron" aria-hidden="true">›</span></button>
      ${detail}
    </div>`;
  }).join('');
}

function toggleStep(id) {
  if (!id) return;
  if (state.openSteps.has(id)) state.openSteps.delete(id);
  else state.openSteps.add(id);
  renderSetup();
}

/* ── Thread badge / freshness ────────────────────────────────────────────── */

const redditThreadUrl = (sub, id) =>
  id ? safeUrl(`https://www.reddit.com/r/${encodeURIComponent(sub)}/comments/${encodeURIComponent(id)}/`) : null;

export function uscfLatestUrl(u) {
  if (!u || !u.url) return null;
  return safeUrl(u.lastPostNumber ? `${String(u.url).replace(/\/+$/, '')}/${encodeURIComponent(u.lastPostNumber)}` : u.url);
}

function renderThreadBadge(st) {
  const tb = $('thread-badge');
  if (!tb) return;
  const parts = [];
  const pm = redditThreadUrl('postmates', st.threadId);
  if (pm) parts.push(externalLink(pm, 'r/postmates', { title: 'Open the Reddit thread' }));
  const ue = redditThreadUrl('UberEATS', st.ueThreadId);
  if (ue) parts.push(externalLink(ue, 'r/UberEATS', { title: 'Open the Reddit thread' }));
  const uscf = uscfLatestUrl(st.uscf);
  if (uscf) parts.push(externalLink(uscf, 'USCardForum', { title: 'Open the forum post' }));

  if (!parts.length) {
    patchHTML(tb, 'No thread loaded — run a source scan');
    tb.title = '';
    return;
  }
  const icon = threadBadgeIcon(st.threadFreshness);
  const month = formatMonth(st.threadMonth || st.ueThreadMonth);
  patchHTML(tb, `${icon ? `${esc(icon)} ` : ''}${parts.join(' + ')}${month ? ` · ${esc(month)}` : ''}`);
  const ids = [];
  if (st.threadId) ids.push(`r/postmates: ${st.threadId}`);
  if (st.ueThreadId) ids.push(`r/UberEATS: ${st.ueThreadId}`);
  if (st.uscf?.topicId) ids.push(`USCardForum: topic ${st.uscf.topicId}`);
  tb.title = ids.join('  ·  ');
}

// ✓ once every thread is on the current month, ⏳/⚠️ while one is catching up.
function threadBadgeIcon(freshness) {
  const states = (freshness?.sources || []).filter(s => s.threadId).map(s => s.state);
  if (states.includes('stale')) return '⚠️';
  if (states.includes('waiting')) return '⏳';
  if (states.length && states.every(s => s === 'found')) return '✓';
  return '';
}

function renderThreadFreshness(freshness) {
  const card = $('thread-status-card');
  const list = $('thread-status-list');
  if (!card || !list) return;
  const sources = (freshness?.sources || []).filter(s => s.threadId || s.state !== 'unknown');
  const hasIssue = sources.some(s => s.state === 'waiting' || s.state === 'stale');
  // Shown early in the month (positive confirmation) or whenever a source lags.
  if (!sources.length || (!freshness.earlyMonth && !hasIssue)) { card.hidden = true; return; }
  card.hidden = false;

  const monthName = formatMonth(freshness.currentMonth) || 'this month';
  setText('thread-status-month', formatMonth(freshness.currentMonth));
  patchHTML(list, sources.map(s => {
    const name = `<strong>${esc(s.label)}</strong>`;
    let icon; let cls; let text;
    if (s.state === 'found') {
      const when = s.detectedAt ? ` · detected ${esc(formatDateTime(s.detectedAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}` : '';
      [icon, cls, text] = ['✅', 'found', `${name} — ${esc(monthName)} thread found${when}`];
    } else if (s.state === 'waiting') {
      [icon, cls, text] = ['⏳', 'waiting', `${name} — waiting for the ${esc(monthName)} thread…`];
    } else if (s.state === 'stale') {
      [icon, cls, text] = ['⚠️', 'stale', `${name} — still on last month's thread (${esc(monthName)} not detected)`];
    } else {
      [icon, cls, text] = ['➖', 'unknown', `${name} — no thread yet`];
    }
    const href = s.subreddit ? redditThreadUrl(s.subreddit, s.threadId) : null;
    const link = href ? ` ${externalLink(href, s.threadId, { cls: 'thread-status-link', title: 'Open the Reddit thread' })}` : '';
    return `<div class="thread-status-row ${cls}"><span class="thread-status-icon" aria-hidden="true">${icon}</span><span class="thread-status-text">${text}${link}</span></div>`;
  }).join(''));
}

/* ── Savings graph ───────────────────────────────────────────────────────── */

function renderSavingsGraph(monthly, currentMonth) {
  const card = $('savings-graph-card');
  const el = $('savings-graph');
  if (!card || !el) return;
  const data = (Array.isArray(monthly) ? monthly : []).slice(-6).map(m => ({ month: m.month, saved: Number(m.saved) || 0 }));
  if (!data.some(m => m.saved > 0)) { card.hidden = true; return; }
  card.hidden = false;

  const max = Math.max(...data.map(m => m.saved), 1);
  setText('savings-graph-total', `${formatMoney(data.reduce((s, m) => s + m.saved, 0))} total`);
  const changed = patchHTML(el, data.map(m => {
    const px = m.saved > 0 ? Math.max(Math.round((m.saved / max) * 90), 6) : 2;
    const current = m.month === currentMonth;
    const label = formatMonth(m.month, 'short') || String(m.month || '');
    return `<div class="savings-col${current ? ' current' : ''}" title="${esc(formatMonth(m.month) || m.month)}: ${esc(formatMoney(m.saved))}">
      <span class="savings-col-value">${esc(formatMoney(m.saved))}</span>
      <div class="savings-col-bar" data-h="${px}"></div>
      <span class="savings-col-label">${esc(label)}</span>
    </div>`;
  }).join(''));
  if (changed) el.querySelectorAll('.savings-col-bar').forEach(bar => { bar.style.height = `${bar.dataset.h}px`; });
}

/* ── Chips ───────────────────────────────────────────────────────────────── */

const platformTag = p => (p === 'ubereats' ? '<span class="platform-tag">Uber Eats</span>' : '');

function renderSuccessList(items) {
  const list = Array.isArray(items) ? items : [];
  const view = statsView();
  setText('success-count', list.length);
  patchHTML($('success-list'), list.length
    ? list.map(item => `<button type="button" class="success-chip" data-action="copy-code" data-code="${esc(item.code)}" data-focus-key="sc-${esc(rowFocus(item))}" title="Click to copy ${esc(item.code)}">
        <span class="success-chip-code">${esc(item.code)}</span>${item.amount ? `<span class="success-chip-value">${esc(item.amount)}</span>` : ''}${platformTag(item.platform)}${item.already ? '<span class="platform-tag">already on account</span>' : ''}${accountTag(item, view)}
      </button>`).join('')
    : '<div class="empty-state">No successful codes yet this month</div>');
}

// Applied, but locked to another area — visible, yet clearly not counted.
function renderRegionLocked(items) {
  const list = Array.isArray(items) ? items : [];
  show('region-locked-card', list.length > 0);
  if (!list.length) return;
  setText('region-locked-count', list.length);
  const view = statsView();
  patchHTML($('region-list'), list.map(item => `<button type="button" class="region-chip" data-action="copy-code" data-code="${esc(item.code)}" data-focus-key="rc-${esc(rowFocus(item))}" title="Click to copy ${esc(item.code)}">
      <span class="region-chip-code">${esc(item.code)}</span>${item.amount ? `<span class="region-chip-amt">${esc(item.amount)}</span>` : ''}${item.location ? `<span class="region-chip-loc">📍 ${esc(item.location)}</span>` : ''}${platformTag(item.platform)}${accountTag(item, view)}
    </button>`).join(''));
}

/* ── Recent activity ─────────────────────────────────────────────────────── */

function renderActivity() {
  const feed = $('activity-feed');
  if (!feed) return;
  const recent = state.processed.filter(r => r && !state.hidden.processed.has(rowKey(r))).slice(-8).reverse();
  const view = viewOf(state.processedScope);
  patchHTML(feed, recent.length
    ? recent.map(r => `<div class="activity-item">
        <span class="activity-dot dot-${cssToken(r.result)}" aria-hidden="true"></span>
        <span class="activity-text">${resultIcon(r.result)} <strong>${esc(r.code)}</strong>${accountTag(r, view)} — ${esc(resultLabel(r.result))}${r.detail ? `<span class="activity-detail"> · ${esc(r.detail)}</span>` : ''}${r.sourceLabel ? ` <span class="inline-meta-pill">${esc(r.sourceLabel)}</span>` : ''}</span>
        ${r.ts ? `<span class="activity-time">${esc(timeAgo(r.ts))}</span>` : ''}
      </div>`).join('')
    : '<div class="empty-state">No activity yet</div>');
}

/* ── Monitored sources ───────────────────────────────────────────────────── */

const STATUS_LABELS = { ok: 'Healthy', checking: 'Checking', error: 'Error', idle: 'Idle' };

function renderMonitoredSources(sources) {
  const list = Array.isArray(sources) ? sources : [];
  setText('sources-count', `${list.filter(s => s.status && s.status !== 'idle').length} active`);
  patchHTML($('sources-list'), list.length
    ? list.map(source => {
      const status = STATUS_LABELS[source.status] ? source.status : 'idle';
      const href = safeUrl(source.sourceUrl);
      const title = source.key === 'uscf' ? 'Open the forum post' : 'Open the Reddit thread';
      const pills = [
        source.note ? `<span class="meta-pill">${esc(source.note)}</span>` : '',
        source.usableCodes !== undefined && source.usableCodes !== null ? `<span class="meta-pill">${esc(source.usableCodes)} candidates</span>` : '',
        source.queued !== undefined && source.queued !== null ? `<span class="meta-pill">${esc(source.queued)} queued</span>` : '',
        source.lastCheckedAt ? `<span class="meta-pill">Checked ${esc(timeAgo(source.lastCheckedAt))}</span>` : '',
      ].join('');
      return `<div class="source-row">
        <div class="source-main">
          <div class="source-title-row">
            <div class="source-name">${esc(source.label || source.key)}</div>
            <span class="source-status-chip status-${cssToken(status)}">${esc(STATUS_LABELS[status])}</span>
          </div>
          <div class="source-meta-row">${pills}</div>
        </div>
        ${href ? externalLink(href, 'Open ↗', { cls: 'btn btn-secondary btn-sm', title }) : ''}
      </div>`;
    }).join('')
    : '<div class="empty-state">Source status will appear after the first scan</div>');
}

/** Toast + last-run label after a scan finishes (called from the SSE handler). */
export function scanFinished(data) {
  if (data.error) {
    showToast(`Source scan failed: ${data.error}`, 'error');
    setLastRun('reddit', 'Error', true);
    return;
  }
  const total = Number(data.newCodes) || 0;
  showToast(`Source scan done — ${plural(total, 'new code')} found`);
  setLastRun('reddit', total > 0 ? `✅ ${plural(total, 'new code')}` : '✅ Done, 0 new');
}
