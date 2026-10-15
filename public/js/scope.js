// Multiple accounts: which account the dashboard is looking at and the query
// strings that scope reads and per-row actions. With the setting off nothing
// here adds a parameter to any request.

import { state } from './state.js';
import { escapeHtml as esc } from './util.js';

export const ALL = 'all';
export const MAIN = 'main';

// A read made before the first stats arrive (the mode isn't known yet) carries
// no parameter, so the server answers with its default: every account when
// the setting is on, `main` when it's off.
export const SERVER_DEFAULT = '*default';

const STORE_KEY = 'promoTracker.account';
const VALID_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The setting. Settings win over stats: a toggle updates them first. */
export function isMulti() {
  const s = state.settings?.multiAccount;
  if (typeof s === 'boolean') return s;
  return state.stats?.multiAccount === true;
}

/** Every account (stats.accounts) while the setting is on; [] when it's off. */
export function accountList() {
  if (!isMulti()) return [];
  const list = state.stats?.accounts;
  return Array.isArray(list) ? list.filter(a => a && typeof a.id === 'string' && a.id) : [];
}

export const accountById = id => (id ? accountList().find(a => a.id === id) || null : null);

/** Current name for an account id (the list wins over a row's possibly stale copy). */
export function accountName(id, fallback = '') {
  const a = accountById(id);
  return (a && a.name) || fallback || String(id || '');
}

/* ── The switcher's choice (kept per browser) ────────────────────────────── */

export function loadChoice() {
  let v = null;
  try { v = localStorage.getItem(STORE_KEY); } catch { /* storage blocked */ }
  state.accountChoice = typeof v === 'string' && VALID_ID.test(v) ? v : ALL;
}

export function setChoice(id) {
  const v = typeof id === 'string' && VALID_ID.test(id) ? id : ALL;
  state.accountChoice = v;
  try { localStorage.setItem(STORE_KEY, v); } catch { /* storage blocked: the choice lasts this visit */ }
  return v;
}

/**
 * The stored choice no longer exists -> back to "All accounts". Only a full
 * list (setting on) is trusted, so a mode change never wipes the choice.
 */
export function reconcileChoice(accounts) {
  if (!Array.isArray(accounts)) return false;
  const c = state.accountChoice;
  if (c === ALL || accounts.some(a => a && a.id === c)) return false;
  setChoice(ALL);
  return true;
}

/* ── Read scope ──────────────────────────────────────────────────────────── */

/** The account reads are scoped to: null with the setting off, else 'all' or an id. */
export function scope() {
  if (!isMulti()) return null;
  const c = state.accountChoice;
  return c !== ALL && accountById(c) ? c : ALL;
}

/** Scope for the next read; SERVER_DEFAULT until the mode is known. */
export function readScope() {
  if (!state.stats && typeof state.settings?.multiAccount !== 'boolean') return SERVER_DEFAULT;
  return scope();
}

/** The scope this browser wants, judged from a fresh stats response. */
export function scopeFor(stats) {
  if (!stats?.multiAccount) return null;
  const c = state.accountChoice;
  return c !== ALL && Array.isArray(stats.accounts) && stats.accounts.some(a => a && a.id === c) ? c : ALL;
}

/** Does data read with `had` already show what `want` asks for? */
export function sameScope(had, want) {
  return had === want || (had === SERVER_DEFAULT && (want === null || want === ALL));
}

/** What a list read with scope `s` shows: 'all', an id, or null (setting off). */
export function viewOf(s) {
  if (!isMulti()) return null;
  return s === SERVER_DEFAULT ? ALL : s;
}

/** What the current stats show. */
export function statsView() {
  const st = state.stats;
  if (!isMulti() || !st?.multiAccount) return null;
  return st.selectedAccount || ALL;
}

/** '?account=…' for a read ('' with the setting off or before the mode is known). */
export const scopeQuery = s => (s && s !== SERVER_DEFAULT ? `?account=${encodeURIComponent(s)}` : '');

/** '?account=…' for an action on one row's (or one account's) data; '' with the setting off. */
export function accountQuery(id) {
  return isMulti() && id ? `?account=${encodeURIComponent(id)}` : '';
}

/* ── Rows ────────────────────────────────────────────────────────────────── */

/** Stable key for a queue/result row: one code can be queued for several accounts. */
export const rowKey = item => `${item?.account || ''}|${item?.code ?? ''}`;

/** Focus-key fragment for a row's controls. */
export const rowFocus = item => (item?.account ? `${item.account}-${item.code ?? ''}` : String(item?.code ?? ''));

/** Small account tag for a row, shown only while the view spans every account. */
export function accountTag(item, view, cls = 'account-tag') {
  if (view !== ALL || !item?.account) return '';
  const name = accountName(item.account, item.accountName);
  return name ? `<span class="${cls}" title="Account: ${esc(name)}">${esc(name)}</span>` : '';
}

/** Key for a login window in state.login (single mode always uses `main`). */
export const loginKey = (account, target) => `${account || MAIN}:${target === 'ubereats' ? 'ubereats' : 'postmates'}`;
