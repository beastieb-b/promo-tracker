// Loaders: fetch from the API, store in state, publish the topic. Each loader
// throws on failure; background callers wrap it in quiet().

import { api } from './api.js';
import { state, publish } from './state.js';
import { setDisplayTimeZone } from './util.js';
import { isVisible } from './router.js';

// Drop responses that arrive after a newer request for the same resource
// (a slow poll must not overwrite a fresher post-action reload).
const seq = {};
async function latest(key, fn) {
  const n = (seq[key] = (seq[key] || 0) + 1);
  const result = await fn();
  return n === seq[key] ? result : undefined;
}

export async function loadMeta() {
  const meta = await latest('meta', () => api('GET', '/api/meta'));
  if (meta === undefined) return;
  state.meta = meta;
  setDisplayTimeZone(meta.timezone);
  publish('meta');
}

export async function loadStats() {
  const startedAt = Date.now();
  const stats = await latest('stats', () => api('GET', '/api/stats'));
  if (stats === undefined) return;
  state.stats = stats;
  if (stats.settings) state.settings = stats.settings;
  // An SSE event newer than this request wins over the polled scanStatus.
  if (stats.scanStatus && startedAt >= state.scanStatusAt) state.scanStatus = stats.scanStatus;
  publish('stats');
}

export async function loadProcessed() {
  const data = await latest('processed', () => api('GET', '/api/processed'));
  if (data === undefined) return;
  state.processed = Array.isArray(data.processed) ? data.processed : [];
  publish('processed');
}

export async function loadQueue() {
  const data = await latest('queue', () => api('GET', '/api/queue'));
  if (data === undefined) return;
  state.queue = Array.isArray(data.queue) ? data.queue : [];
  state.queueLoaded = true;
  publish('queue');
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
