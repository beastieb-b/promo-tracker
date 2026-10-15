// Loaders: fetch from the API, store in state, publish the topic. Each loader
// throws on failure; background callers wrap it in quiet().

import { api } from './api.js';
import { state, publish } from './state.js';
import { setDisplayTimeZone } from './util.js';
import { isVisible } from './router.js';
import { readScope, scopeFor, scopeQuery, sameScope, reconcileChoice, SERVER_DEFAULT, ALL } from './scope.js';

// Drop responses that arrive after a newer request for the same resource
// (a slow poll must not overwrite a fresher post-action reload).
const seq = {};
async function latest(key, fn) {
  const n = (seq[key] = (seq[key] || 0) + 1);
  const result = await fn();
  return n === seq[key] ? result : undefined;
}

// Account scope each list was last requested with (undefined = never).
const requested = { processed: undefined, queue: undefined };

export async function loadMeta() {
  const meta = await latest('meta', () => api('GET', '/api/meta'));
  if (meta === undefined) return;
  state.meta = meta;
  setDisplayTimeZone(meta.timezone);
  publish('meta');
}

// Stats for the account this browser selected. Without a parameter (first
// load, or the setting just changed) the server picks its default; when that
// isn't the stored choice, ask again for the right one.
async function fetchStats() {
  const sent = readScope();
  const stats = await api('GET', `/api/stats${scopeQuery(sent)}`);
  const want = scopeFor(stats);
  const got = stats?.selectedAccount || (sent && sent !== SERVER_DEFAULT ? sent : ALL);
  if (want && want !== got) return api('GET', `/api/stats${scopeQuery(want)}`);
  return stats;
}

let statsPending = null;   // the stats load in flight, if any

export async function loadStats() {
  const run = loadStatsNow();
  statsPending = run;
  try {
    await run;
  } finally {
    if (statsPending === run) statsPending = null;
  }
}

async function loadStatsNow() {
  const startedAt = Date.now();
  const stats = await latest('stats', fetchStats);
  if (stats === undefined) return;
  state.stats = stats;
  if (stats.settings) state.settings = stats.settings;
  // An SSE event newer than this request wins over the polled scanStatus.
  if (stats.scanStatus && startedAt >= state.scanStatusAt) state.scanStatus = stats.scanStatus;
  if (stats.multiAccount) reconcileChoice(stats.accounts);
  publish('stats');
  ensureListScope();
}

// Before the first stats it isn't known whether accounts are on. With one
// account picked in this browser, wait for them instead of briefly showing
// every account's rows (the server's default).
async function settleScope() {
  // A newer stats load can supersede the one awaited (its result is dropped),
  // so wait for that one too — a few rounds at most.
  for (let i = 0; i < 3 && !state.stats && state.accountChoice !== ALL; i++) {
    try { await (statsPending || loadStats()); } catch { return; /* the read goes out with the default */ }
  }
}

export async function loadProcessed() {
  await settleScope();
  const sent = readScope();
  requested.processed = sent;
  const data = await latest('processed', () => api('GET', `/api/processed${scopeQuery(sent)}`));
  if (data === undefined) return;
  state.processed = Array.isArray(data.processed) ? data.processed : [];
  state.processedScope = sent;
  publish('processed');
}

export async function loadQueue() {
  await settleScope();
  const sent = readScope();
  requested.queue = sent;
  const data = await latest('queue', () => api('GET', `/api/queue${scopeQuery(sent)}`));
  if (data === undefined) return;
  state.queue = Array.isArray(data.queue) ? data.queue : [];
  state.queueScope = sent;
  state.queueLoaded = true;
  publish('queue');
}

/** Reload the lists if they were read for another account (or mode) than the one now selected. */
export function ensureListScope() {
  const want = readScope();
  if (requested.processed !== undefined && !sameScope(requested.processed, want)) quiet(loadProcessed);
  if (requested.queue !== undefined && !sameScope(requested.queue, want)) quiet(loadQueue);
}

// Toggling the setting brings settings_updated + accounts_updated (SSE) and the
// POST response within a few ms of each other: one reload covers them all.
let scopedTimer = 0;
let scopedWaiters = [];

/** The account selection, the account list or the setting changed: reload everything per account. */
export function refreshScoped() {
  clearTimeout(scopedTimer);
  return new Promise(resolve => {
    scopedWaiters.push(resolve);
    scopedTimer = setTimeout(async () => {
      const waiters = scopedWaiters;
      scopedWaiters = [];
      await Promise.all([
        quiet(loadStats),
        requested.processed !== undefined ? quiet(loadProcessed) : null,
        requested.queue !== undefined ? quiet(loadQueue) : null,
      ]);
      waiters.forEach(fn => fn());
    }, 40);
  });
}

export async function loadLog() {
  const data = await latest('log', () => api('GET', '/api/log?limit=200'));
  if (data === undefined) return;
  state.logs = Array.isArray(data) ? data : [];
  state.logLoaded = true;
  publish('log');
}

export async function loadAccess() {
  try {
    const data = await latest('access', () => api('GET', '/api/access'));
    if (data === undefined) return;
    state.access = data;
    state.accessError = null;
  } catch (err) {
    state.accessError = err.message;
  }
  publish('access');
}

/** Run a loader for background refresh: failures are ignored (next poll retries). */
export async function quiet(loader) {
  try { await loader(); return true; } catch { return false; }
}

/** Background refresh of everything the current view shows. */
export async function refreshAll() {
  await Promise.all([
    quiet(loadStats),
    quiet(loadProcessed),
    isVisible('queue') ? quiet(loadQueue) : null,
    isVisible('log') ? quiet(loadLog) : null,
  ]);
}
