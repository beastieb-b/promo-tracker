// Settings page: logins, sources, self-test, home region, remote access,
// schedule, about. Fields the user is editing are never overwritten by polls.
// Login buttons and the multiple-accounts cards live in accounts.js.

import { state, subscribe, publish } from './state.js';
import { api, reportError } from './api.js';
import { onAction } from './actions.js';
import { showToast } from './toast.js';
import { isVisible } from './router.js';
import { loadAccess, loadStats, quiet } from './data.js';
import { renderSetup, uscfLatestUrl } from './overview.js';
import { renderLoginButtons } from './accounts.js';
import {
  $, escapeHtml as esc, safeUrl, timeAgo, intervalLabel, formatMonth, formatDay, formatWait,
  setText, show, patchHTML, copyText, setBadge,
} from './util.js';

export function initSettings() {
  for (const topic of ['stats', 'settings', 'meta', 'login', 'selftest', 'scanStatus']) subscribe(topic, renderSettings);
  subscribe('meta', renderMetaText);
  subscribe('access', renderAccess);
  subscribe('section', section => { if (section === 'settings') refreshAccess(); });
  subscribe('meta', () => { if (isVisible('settings')) refreshAccess(); });

  const markDirty = (e, el) => { el.dataset.dirty = 'true'; };
  onAction('input', 'setting-field', markDirty);
  onAction('change', 'setting-field', markDirty);
  onAction('change', 'save-interval', saveInterval);
  onAction('submit', 'save-home-region', saveHomeRegion);
  onAction('click', 'self-test', runSelfTest);
  onAction('click', 'copy-access-link', (e, el) => copyAccessLink(Number(el.dataset.index)));
  onAction('click', 'select-all', (e, el) => el.select());
}

/* ── Shared copy helpers ─────────────────────────────────────────────────── */

/** "the daily check at 4:45 AM (this Mac's time)" — from /api/meta, never hard-coded. */
export function dailyCheckPhrase() {
  const t = state.meta?.dailyCheckTime;
  if (!t) return 'the daily check';
  return `the daily check at ${t} (${state.meta?.viewerIsLocal === false ? "the Mac's" : "this Mac's"} time)`;
}

/** Fill every [data-meta] placeholder in static copy from /api/meta. */
function renderMetaText() {
  const m = state.meta || {};
  const values = {
    reapplySkipDays: Number.isFinite(Number(m.reapplySkipDays)) && m.reapplySkipDays !== null ? String(m.reapplySkipDays) : null,
    maxCodesPerRun: Number.isFinite(Number(m.maxCodesPerRun)) && m.maxCodesPerRun !== null ? String(m.maxCodesPerRun) : null,
    codeWait: formatWait(m.codeWaitMs),
    dailyCheckTime: m.dailyCheckTime || null,
  };
  document.querySelectorAll('[data-meta]').forEach(el => {
    const v = values[el.dataset.meta];
    if (v) setText(el, v);
  });
}

/* ── Field helpers ───────────────────────────────────────────────────────── */

/** Write a value unless the user is in the field or has unsaved edits in it. */
function syncField(el, value) {
  if (!el || el === document.activeElement || el.dataset.dirty === 'true') return;
  const v = value ?? '';
  if (el.type === 'checkbox') el.checked = Boolean(v);
  else if (el.value !== String(v)) el.value = String(v);
}

function populateIntervals(el, options, current) {
  if (!el || el === document.activeElement || el.dataset.dirty === 'true') return;
  const cur = Number(current);
  const values = [...new Set([...(Array.isArray(options) ? options : []), ...(Number.isFinite(cur) && cur > 0 ? [cur] : [])]
    .map(Number).filter(n => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
  patchHTML(el, values.map(v => `<option value="${esc(v)}">${esc(intervalLabel(v))}</option>`).join(''));
  if (Number.isFinite(cur) && cur > 0 && el.value !== String(cur)) el.value = String(cur);
}

function applySavedSettings(saved) {
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    state.settings = { ...state.settings, ...saved };
    if (state.stats) state.stats.settings = state.settings;
  }
  publish('settings');
}

/* ── Render ──────────────────────────────────────────────────────────────── */

export function renderSettings() {
  const s = state.settings || {};
  const st = state.stats;

  populateIntervals($('scan-interval'), state.meta?.scanIntervals, s.scanIntervalHours);
  populateIntervals($('apply-interval'), state.meta?.applyIntervals, s.applyIntervalHours);
  renderScheduleFooter(s);

  if (st) {
    syncField($('home-region-input'), s.homeRegion || '');
    const region = String(s.homeRegion || '').toLowerCase();
    syncField($('home-aliases-input'), (Array.isArray(s.homeAliases) ? s.homeAliases : [])
      .filter(a => String(a).toLowerCase() !== region).join(', '));
    syncField($('home-state-input'), s.homeState || '');
  }

  renderLoginCard(st?.loggedIn, 'login-status-badge', 'login-status-desc', 'Postmates', Boolean(st));
  renderLoginCard(st?.ueLoggedIn, 'ue-login-status-badge', 'ue-login-status-desc', 'Uber Eats', Boolean(st));
  renderLoginButtons();
  renderSelfTest();
  if (st) {
    renderSources(st);
    renderSetup();
  }
  renderAccess();

  setText('about-version', st?.appVersion ? `v${st.appVersion}` : state.meta?.version ? `v${state.meta.version}` : '—');
  if (st) setText('about-reset', formatDay(st.lastResetDate) || 'No reset yet');
}

function renderScheduleFooter(s) {
  const scan = Number(s.scanIntervalHours);
  const apply = Number(s.applyIntervalHours);
  if (!(scan > 0)) return;
  let text = `Scanning sources ${intervalLabel(scan).toLowerCase()}`;
  if (apply > 0) text += ` · applying codes ${intervalLabel(apply).toLowerCase()}`;
  setText('next-scan-label', text);
}

// Tri-state: true = confirmed working, null = saved but unverified, false = not logged in.
function renderLoginCard(loggedIn, badgeId, descId, name, loaded) {
  if (!loaded) return;
  const badge = $(badgeId);
  if (loggedIn === true) setBadge(badge, '✓ Logged In', 'badge-ok');
  else if (loggedIn === false) setBadge(badge, '⚠ Not Logged In', 'badge-warn');
  else setBadge(badge, '? Unverified', 'badge-info');
  setText(descId, loggedIn === true
    ? 'Session confirmed working.'
    : loggedIn === false
      ? `Not logged in or session expired. Click the button to open Chrome and log in to ${name}.`
      : `A saved session exists but hasn't been verified yet — it's checked right after login, by ${dailyCheckPhrase()}, and on apply runs.`);
}

function renderSelfTest() {
  const running = state.selfTest.running || state.scanStatus?.browserBusy === 'selftest';
  const btn = $('btn-selftest');
  if (btn) {
    btn.disabled = running;
    setText(btn, running ? '⏳ Testing…' : '🧪 Run Test');
  }
  const badge = $('selftest-badge');
  const desc = $('selftest-desc');
  const result = state.selfTest.result;
  if (running) {
    show(badge, true);
    setBadge(badge, 'Running…', 'badge-running');
    setText(desc, 'Opening Chrome and applying a fake code — takes about 30 seconds…');
  } else if (result) {
    show(badge, true);
    setBadge(badge, result.ok ? '✓ Healthy' : '⚠ Problem', result.ok ? 'badge-ok' : 'badge-error');
    setText(desc, result.message || 'Test finished.');
  } else {
    show(badge, false);
    setText(desc, SELFTEST_DESC);
  }
}

const SELFTEST_DESC = 'Applies a fake promo code through the real automation and verifies Postmates rejects it. Run this if results look wrong.';

function renderSources(st) {
  setText('thread-month-badge', formatMonth(st.threadMonth || st.ueThreadMonth) || 'No thread yet');
  threadRow('thread-id-label', 'thread-link', st.threadId, 'postmates', st.threadMonth);
  threadRow('ue-thread-id-label', 'ue-thread-link', st.ueThreadId, 'UberEATS', st.ueThreadMonth);

  // USCardForum: one continuous topic; the link jumps to its newest post.
  const u = st.uscf || {};
  const link = $('uscf-link');
  let href = null;
  if (u.url && u.lastScanAt) {
    const latest = u.lastPostNumber ? ` · latest post #${u.lastPostNumber}` : '';
    setText('uscf-label', `Topic ${u.topicId ?? '—'}${latest} · read ${timeAgo(u.lastScanAt)}`);
    href = uscfLatestUrl(u);
  } else {
    setText('uscf-label', 'Not scanned yet — runs with the next source scan');
    href = safeUrl(u.url);
  }
  if (link) {
    if (href) link.href = href; else link.removeAttribute('href');
    link.hidden = !href;
  }
}

function threadRow(labelId, linkId, threadId, subreddit, month) {
  const link = $(linkId);
  const href = threadId ? safeUrl(`https://www.reddit.com/r/${subreddit}/comments/${encodeURIComponent(threadId)}/`) : null;
  setText(labelId, threadId
    ? `Thread: ${threadId}${formatMonth(month) ? `  ·  ${formatMonth(month)}` : ''}`
    : 'No thread detected — run a source scan');
  if (link) {
    if (href) link.href = href; else link.removeAttribute('href');
    link.hidden = !href;
  }
}

/* ── Remote access (viewer on the Mac only) ──────────────────────────────── */

function refreshAccess() {
  if (state.meta?.viewerIsLocal) loadAccess();
}

// Escaped text with `code` spans turned into <code>.
const withCode = text => esc(text).replace(/`([^`]+)`/g, '<code>$1</code>');

function renderAccess() {
  const card = $('access-card');
  if (!card) return;
  const local = Boolean(state.meta?.viewerIsLocal);
  card.hidden = !local;
  if (!local) return;

  const a = state.access;
  const body = $('access-body');
  const badge = $('access-badge');
  if (!a) {
    setBadge(badge, '', null);
    patchHTML(body, state.accessError
      ? `<div class="settings-note error-text">Couldn't load remote access info: ${esc(state.accessError)}</div>`
      : '<div class="settings-note">Loading…</div>');
    return;
  }
  const links = Array.isArray(a.links) ? a.links.filter(l => typeof l === 'string' && l) : [];
  if (a.networkAccess && links.length) {
    setBadge(badge, 'On', 'badge-ok');
    patchHTML(body, `${links.map((link, i) => `<div class="settings-row access-row">
        <input type="text" class="code-input text-input access-link" readonly value="${esc(link)}" aria-label="Access link ${i + 1}" data-action="select-all">
        <button type="button" class="btn btn-secondary btn-sm copy-btn" data-action="copy-access-link" data-index="${i}" data-focus-key="al-${i}" aria-label="Copy access link ${i + 1}">Copy</button>
      </div>`).join('')}
      <div class="settings-note">Open this link once on each phone/laptop; it signs that browser in for a year. Anyone with the link can control the app — keep it private.</div>`);
  } else {
    setBadge(badge, 'Off', 'badge-muted');
    patchHTML(body, `<div class="settings-note">${withCode(a.note || 'Remote access is off: the dashboard only answers on this Mac.')}</div>`);
  }
}

async function copyAccessLink(i) {
  const link = state.access?.links?.[i];
  if (!link) return;
  try {
    await copyText(link);
    showToast('Link copied — keep it private', 'success');
  } catch {
    const field = document.querySelectorAll('.access-link')[i];
    field?.focus();
    field?.select();
    showToast('Copy failed — the link is selected, copy it manually', 'error');
  }
}

/* ── Actions ─────────────────────────────────────────────────────────────── */

async function saveInterval(e, el) {
  const key = el.dataset.key;
  const value = parseFloat(el.value);
  if (!key || !Number.isFinite(value)) return;
  el.dataset.dirty = 'true';
  try {
    applySavedSettings(await api('POST', '/api/settings', { [key]: value }));
    showToast('Schedule saved', 'success');
  } catch (err) {
    reportError(err, "Couldn't save the schedule");
  } finally {
    delete el.dataset.dirty;
    renderSettings();   // shows the saved value (or reverts a rejected one)
  }
}

async function saveHomeRegion(e, form) {
  const fields = ['home-region-input', 'home-aliases-input', 'home-state-input'].map(id => $(id));
  const [regionEl, aliasesEl, stateEl] = fields;
  const homeRegion = (regionEl?.value || '').trim();
  const homeAliases = (aliasesEl?.value || '').split(',').map(a => a.trim()).filter(Boolean);
  const homeState = (stateEl?.value || '').trim();
  const btn = form.querySelector('button[type="submit"]');
  const status = $('home-region-status');
  if (btn) btn.disabled = true;
  try {
    const saved = await api('POST', '/api/settings', { homeRegion, homeAliases, homeState });
    fields.forEach(f => { if (f) delete f.dataset.dirty; });
    applySavedSettings(saved);
    showToast(homeRegion ? 'Home region saved' : 'Home region cleared', 'success');
    if (status) {
      setText(status, '✓ Saved');
      setTimeout(() => setText(status, ''), 2500);
    }
    quiet(loadStats);   // setup checklist + region classification may change
  } catch (err) {
    reportError(err, "Couldn't save the home region");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function runSelfTest() {
  if (state.selfTest.running) return;
  state.selfTest = { running: true, result: null };
  publish('selftest');
  try {
    await api('POST', '/api/self-test');
  } catch (err) {
    state.selfTest.running = false;
    publish('selftest');
    reportError(err, "Couldn't start the self-test");
  }
}
