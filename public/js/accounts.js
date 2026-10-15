// Multiple accounts: the Settings toggle and Accounts card, the account
// switcher on Dashboard / Queue / Results, the add-code account picker, and
// every login button (single-account cards, banners and per-account rows).
// With the setting off only the toggle is visible and no request carries an
// account.

import { state, subscribe, publish } from './state.js';
import { api, reportError } from './api.js';
import { onAction } from './actions.js';
import { showToast } from './toast.js';
import { loadStats, refreshScoped, quiet } from './data.js';
import {
  ALL, MAIN, isMulti, accountList, accountById, accountName, loadChoice, setChoice, scope,
  reconcileChoice, loginKey,
} from './scope.js';
import { $, escapeHtml as esc, cssToken, formatMoney, platformName, plural, setText, show, patchHTML, setBadge } from './util.js';

const NAME_MAX = 30;
let savingMode = false;

export function initAccounts() {
  loadChoice();
  for (const topic of ['stats', 'settings', 'login', 'scanStatus']) subscribe(topic, renderAccounts);

  onAction('change', 'switch-account', (e, el) => switchAccount(el.value));
  onAction('change', 'toggle-multi', toggleMulti);
  onAction('submit', 'add-account', addAccount);
  onAction('submit', 'rename-account', renameAccount);
  onAction('input', 'account-name-field', (e, el) => { el.dataset.dirty = 'true'; });
  onAction('click', 'remove-account', (e, el) => removeAccount(el.dataset.account, el));
  onAction('click', 'login', (e, el) => startLogin(el.dataset.target, el.dataset.account));
}

export function renderAccounts() {
  renderModeCard();
  renderSwitchers();
  renderAddCodeAccount();
  renderAccountsCard();
}

/* ── Settings: the toggle ────────────────────────────────────────────────── */

function modeKnown() {
  return Boolean(state.stats) || typeof state.settings?.multiAccount === 'boolean';
}

function renderModeCard() {
  const toggle = $('multi-account-toggle');
  const multi = isMulti();
  if (toggle && !savingMode) {
    toggle.checked = multi;
    toggle.disabled = !modeKnown();
  }
  const badge = $('multi-account-badge');
  if (!modeKnown()) setBadge(badge, '', null);
  else setBadge(badge, multi ? 'On' : 'Off', multi ? 'badge-ok' : 'badge-muted');
}

async function toggleMulti(e, el) {
  if (savingMode) return;
  const want = Boolean(el.checked);
  savingMode = true;
  el.disabled = true;
  try {
    const saved = await api('POST', '/api/settings', { multiAccount: want });
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      state.settings = { ...state.settings, ...saved };
    }
    if (typeof state.settings.multiAccount !== 'boolean') state.settings.multiAccount = want;
    if (state.stats) {
      state.stats.settings = state.settings;
      state.stats.multiAccount = state.settings.multiAccount;
    }
    showToast(want
      ? 'Multiple accounts on — add accounts and log each one in below'
      : 'Multiple accounts off — only the first account is used', 'success');
    publish('settings');
    if (state.stats) publish('stats');   // switchers, tags and banners follow the mode now
    await refreshScoped();
  } catch (err) {
    el.checked = !want;
    reportError(err, "Couldn't change the setting");
  } finally {
    savingMode = false;
    renderAccounts();
  }
}

/* ── Switchers (Dashboard / Queue / Results) ─────────────────────────────── */

function accountOptions(list) {
  return `<option value="${ALL}">All accounts</option>${list.map(a => `<option value="${esc(a.id)}">${esc(a.name || a.id)}</option>`).join('')}`;
}

function renderSwitchers() {
  const multi = isMulti();
  document.querySelectorAll('[data-account-switch]').forEach(el => { el.hidden = !multi; });
  if (!multi) return;
  const options = accountOptions(accountList());
  const current = scope() || ALL;
  document.querySelectorAll('select[data-action="switch-account"]').forEach(sel => {
    patchHTML(sel, options);
    if (sel.value !== current) sel.value = current;
  });
}

function switchAccount(value) {
  const id = value === ALL || accountById(value) ? value : ALL;
  if (id === (scope() || ALL)) return;
  setChoice(id);
  renderSwitchers();
  refreshScoped();
}

/** Add-code form: "All accounts" (default) or one account. */
function renderAddCodeAccount() {
  const sel = $('add-code-account');
  if (!sel) return;
  const multi = isMulti();
  show('add-code-account-wrap', multi);
  if (!multi) return;
  const list = accountList();
  const prev = sel.value || ALL;
  patchHTML(sel, accountOptions(list));
  const next = prev !== ALL && list.some(a => a.id === prev) ? prev : ALL;
  if (sel.value !== next) sel.value = next;
}

/* ── Settings: the Accounts card ─────────────────────────────────────────── */

function loginBadge(loggedIn) {
  if (loggedIn === true) return '<span class="card-badge badge-ok">✓ Logged in</span>';
  if (loggedIn === false) return '<span class="card-badge badge-warn">⚠ Not logged in</span>';
  return '<span class="card-badge badge-info" title="Checked right after login, by the daily check, and on apply runs">? Unverified</span>';
}

function platformRow(a, target) {
  const loggedIn = target === 'ubereats' ? a.ueLoggedIn : a.loggedIn;
  const id = esc(a.id);
  return `<div class="account-platform">
      <span class="account-platform-name">${esc(platformName(target))}</span>
      ${loginBadge(loggedIn)}
      <button type="button" class="btn btn-primary btn-sm account-login-btn" data-action="login" data-target="${target}" data-account="${id}" data-focus-key="al-${id}-${target}">🔐 Log in to ${esc(platformName(target))}</button>
    </div>`;
}

function accountEntryHtml(a) {
  const id = esc(a.id);
  const domId = `account-name-${cssToken(a.id)}`;
  const name = a.name || a.id;
  const queued = Number(a.queueCount) || 0;
  const saved = Number(a.savedThisMonth) || 0;
  const remove = a.id === MAIN
    ? '<span class="meta-pill" title="The first account can\'t be removed">First account</span>'
    : `<button type="button" class="btn btn-danger btn-sm" data-action="remove-account" data-account="${id}" data-focus-key="ar-${id}" aria-label="Remove ${esc(name)}">Remove</button>`;
  return `<div class="account-entry">
    <div class="account-head">
      <form class="account-name-form" data-action="rename-account" data-account="${id}" autocomplete="off">
        <label class="visually-hidden" for="${domId}">Name of ${esc(name)}</label>
        <input type="text" id="${domId}" class="code-input text-input account-name-input" value="${esc(name)}" maxlength="${NAME_MAX}" required
               data-action="account-name-field" data-account="${id}" data-focus-key="an-${id}" spellcheck="false">
        <button type="submit" class="btn btn-secondary btn-sm" data-focus-key="as-${id}" aria-label="Save the name of ${esc(name)}">Save</button>
      </form>
      <div class="account-stats">
        <span class="meta-pill">${esc(plural(queued, 'code'))} queued</span>
        <span class="meta-pill account-saved">${esc(formatMoney(saved))} saved this month</span>
      </div>
      <div class="account-remove">${remove}</div>
    </div>
    <div class="account-platforms">
      ${platformRow(a, 'postmates')}
      ${platformRow(a, 'ubereats')}
    </div>
  </div>`;
}

// Polls must not wipe a name being edited: keep typed values across a re-render.
function keepEdits(root) {
  const kept = new Map();
  root.querySelectorAll('input[data-account]').forEach(input => {
    const focused = input === document.activeElement;
    if (input.dataset.dirty !== 'true' && !focused) return;
    kept.set(input.dataset.account, {
      value: input.value, dirty: input.dataset.dirty === 'true', focused,
      start: input.selectionStart, end: input.selectionEnd,
    });
  });
  return kept;
}

function restoreEdits(root, kept) {
  if (!kept.size) return;
  root.querySelectorAll('input[data-account]').forEach(input => {
    const k = kept.get(input.dataset.account);
    if (!k) return;
    // Still being edited, unless the saved name now matches what was typed.
    if (k.dirty && k.value.trim() !== input.defaultValue) {
      if (input.value !== k.value) input.value = k.value;
      input.dataset.dirty = 'true';
    }
    if (k.focused && input === document.activeElement && k.start !== null) {
      try { input.setSelectionRange(k.start, k.end); } catch { /* not a text field */ }
    }
  });
}

function renderAccountsCard() {
  const multi = isMulti();
  show('accounts-card', multi);
  // The Accounts card replaces the single-account login cards.
  show('postmates-login-card', !multi);
  show('ubereats-login-card', !multi);
  if (!multi) return;

  const list = accountList();
  setText('accounts-count', list.length ? plural(list.length, 'account') : '');
  const el = $('accounts-list');
  if (!el) return;
  const kept = keepEdits(el);
  patchHTML(el, list.length
    ? list.map(accountEntryHtml).join('')
    : '<div class="settings-note">Loading accounts…</div>');
  restoreEdits(el, kept);
  renderLoginButtons();
}

async function addAccount(e, form) {
  const input = $('add-account-input');
  const name = (input?.value || '').trim();
  if (!name || name.length > NAME_MAX) {
    showToast(`Account names are 1–${NAME_MAX} characters`, 'error');
    input?.focus();
    return;
  }
  const btn = form.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  try {
    const res = await api('POST', '/api/accounts', { name });
    if (input) input.value = '';
    showToast(`Added ${res.account?.name || name} — log it in to Postmates and Uber Eats below`, 'success');
    await quiet(loadStats);
  } catch (err) {
    reportError(err, `Couldn't add ${name}`);
  } finally {
    if (btn) btn.disabled = false;
  }
}

const nameField = id => [...($('accounts-list')?.querySelectorAll('input[data-account]') || [])].find(i => i.dataset.account === id) || null;

async function renameAccount(e, form) {
  const id = form.dataset.account;
  const a = accountById(id);
  const input = form.querySelector('input[data-account]');
  if (!id || !input) return;
  const name = input.value.trim();
  if (!name || name.length > NAME_MAX) {
    showToast(`Account names are 1–${NAME_MAX} characters`, 'error');
    input.focus();
    return;
  }
  if (a && name === a.name) {
    delete input.dataset.dirty;
    input.value = name;
    showToast('Name unchanged');
    return;
  }
  const btn = form.querySelector('button[type="submit"]');
  if (btn) btn.disabled = true;
  try {
    const res = await api('POST', `/api/accounts/${encodeURIComponent(id)}`, { name });
    const saved = res.account?.name || name;
    // The card may have been re-rendered meanwhile (accounts_updated): settle
    // the field that's on the page now.
    const field = nameField(id) || input;
    delete field.dataset.dirty;
    field.value = saved;
    if (a) a.name = saved;
    showToast(`Renamed to ${saved}`, 'success');
    publish('stats');   // switchers, tags and banners show the new name now
    quiet(loadStats);
  } catch (err) {
    reportError(err, "Couldn't rename the account");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function removeAccount(id, btn) {
  const a = accountById(id);
  if (!a || id === MAIN) return;
  const name = a.name || a.id;
  const ok = window.confirm(`Remove the account "${name}"?\n\n`
    + 'Its Chrome login and history are set aside (not erased), and it stops being used: '
    + 'no more codes are queued or applied for it.');
  if (!ok) return;
  if (btn) btn.disabled = true;
  try {
    await api('DELETE', `/api/accounts/${encodeURIComponent(id)}`);
    if (state.stats && Array.isArray(state.stats.accounts)) {
      state.stats.accounts = state.stats.accounts.filter(x => x.id !== id);
      reconcileChoice(state.stats.accounts);
    }
    for (const target of ['postmates', 'ubereats']) delete state.login[loginKey(id, target)];
    showToast(`Removed ${name}`, 'success');
    publish('stats');
    refreshScoped();
  } catch (err) {
    if (btn) btn.disabled = false;
    reportError(err, `Couldn't remove ${name}`);
  }
}

/** SSE accounts_updated: an account was added/renamed/removed or the setting toggled. */
export function onAccountsUpdated(accounts) {
  if (Array.isArray(accounts) && state.stats) {
    const prev = new Map((Array.isArray(state.stats.accounts) ? state.stats.accounts : []).map(a => [a?.id, a]));
    state.stats.accounts = accounts
      .filter(a => a && typeof a.id === 'string' && a.id)
      .map(a => ({ ...(prev.get(a.id) || {}), ...a }));
    if (isMulti()) reconcileChoice(state.stats.accounts);
    publish('stats');
  }
  refreshScoped();
}

/** Record a login result for one account (multi) or the single account. */
export function setLoginStatus(account, target, value) {
  const st = state.stats;
  if (!st) return;
  const key = target === 'ubereats' ? 'ueLoggedIn' : 'loggedIn';
  if (isMulti()) {
    const a = (Array.isArray(st.accounts) ? st.accounts : []).find(x => x && x.id === (account || MAIN));
    if (a) a[key] = value;
  } else {
    st[key] = value;
  }
}

/** "Partner: " in front of a per-account message (nothing with the setting off). */
export function accountPrefix(d) {
  if (!isMulti()) return '';
  const id = typeof d?.account === 'object' && d.account ? d.account.id : d?.account;
  const fallback = typeof d?.account === 'object' && d.account ? d.account.name : d?.accountName;
  const name = id || fallback ? accountName(id, fallback) : '';
  return name ? `${name}: ` : '';
}

/* ── Login buttons ───────────────────────────────────────────────────────── */

/** Every login button (Settings cards, session banners, account rows) renders from state. */
export function renderLoginButtons() {
  const windowOpen = state.scanStatus?.browserBusy === 'login';
  const multi = isMulti();
  document.querySelectorAll('button[data-action="login"]').forEach(btn => {
    const target = btn.dataset.target === 'ubereats' ? 'ubereats' : 'postmates';
    const name = platformName(target);
    const acct = multi && btn.dataset.account ? accountById(btn.dataset.account) : null;
    const phase = state.login[loginKey(acct ? acct.id : MAIN, target)];
    const loggedIn = acct
      ? (target === 'ubereats' ? acct.ueLoggedIn : acct.loggedIn)
      : (target === 'ubereats' ? state.stats?.ueLoggedIn : state.stats?.loggedIn);
    // Single account: an open login window shows on both buttons (as before).
    // Several accounts: only the button that opened it says so; the rest wait.
    const waiting = phase === 'open' || (windowOpen && !acct);
    let text;
    let label;   // spoken name for a per-account button: platform + account
    if (phase === 'opening') [text, label] = ['⏳ Opening Chrome…', `Opening Chrome for the ${name} login`];
    else if (waiting) [text, label] = ['⏳ Finish login in Chrome', `Finish the ${name} login in Chrome`];
    else if (btn.dataset.variant === 'banner') [text, label] = ['🔐 Log in', `Log in to ${name}`];
    else if (btn.dataset.variant === 'banner-platform') [text, label] = [`🔐 ${name}`, `Log in to ${name}`];
    else if (loggedIn === true) [text, label] = ['🔄 Re-login', `Log in to ${name} again`];
    else [text, label] = [`🔐 Log in to ${name}`, `Log in to ${name}`];
    btn.disabled = Boolean(phase) || windowOpen;
    setText(btn, text);
    if (acct) btn.setAttribute('aria-label', `${label} — ${acct.name || acct.id}`);
    else btn.removeAttribute('aria-label');
  });
}

async function startLogin(target, account) {
  const t = target === 'ubereats' ? 'ubereats' : 'postmates';
  const acct = isMulti() && account ? accountById(account) : null;
  const key = loginKey(acct ? acct.id : MAIN, t);
  if (state.login[key]) return;
  const name = platformName(t);
  const who = acct ? `${acct.name || acct.id}: ` : '';
  state.login[key] = 'opening';
  publish('login');
  try {
    await api('POST', '/api/setup', acct ? { target: t, account: acct.id } : { target: t });
    state.login[key] = 'open';
    showToast(`${who}Opening Chrome for ${name} login — log in, then close the window`);
  } catch (err) {
    delete state.login[key];
    reportError(err, `${who}Couldn't open the ${name} login`);
  } finally {
    publish('login');
  }
}
