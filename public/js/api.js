// The one place that talks to the server: JSON requests and the SSE stream.

import { showToast } from './toast.js';

export class ApiError extends Error {
  constructor(message, { status = 0, busy = false, auth = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.busy = busy;
    this.auth = auth;
  }
}

let authRequiredHandler = null;
/** Called once when the server says this device needs the access link. */
export function onAuthRequired(fn) { authRequiredHandler = fn; }

/**
 * api('GET', '/api/stats') / api('POST', '/api/settings', { ... })
 * Non-GET requests carry the X-Promo-Client CSRF header. Resolves with the
 * parsed JSON body; rejects with an ApiError carrying status/busy/server text.
 */
export async function api(method, path, body, { keepalive = false } = {}) {
  const m = method.toUpperCase();
  const headers = { Accept: 'application/json' };
  if (m !== 'GET' && m !== 'HEAD') headers['X-Promo-Client'] = 'dashboard';
  const init = { method: m, headers, credentials: 'same-origin', cache: 'no-store' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (keepalive) init.keepalive = true;

  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError("Can't reach Promo Tracker — is it running?", { status: 0 });
  }

  let data = null;
  const text = await res.text().catch(() => '');
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }

  if (!res.ok) {
    const err = new ApiError(
      (data && typeof data.error === 'string' && data.error) || `Request failed (HTTP ${res.status})`,
      { status: res.status, busy: res.status === 409 || Boolean(data?.busy), auth: data?.auth ?? null },
    );
    if (res.status === 401 && data?.auth === 'required') authRequiredHandler?.();
    throw err;
  }
  if (text && data === null) throw new ApiError('Unexpected response from the server', { status: res.status });
  return data ?? {};
}

/**
 * Surface a failed user action. 409 "busy" is not a failure: the server's
 * message is shown as a plain notice. 401 is handled by the access notice.
 */
export function reportError(err, what) {
  if (!err) return;
  if (err.status === 401 && err.auth === 'required') return;
  if (err.busy || err.status === 409) {
    showToast(err.message || 'Busy — try again in a moment', 'info');
    return;
  }
  const msg = err.message || String(err);
  // 400 = validation: the server's text already says what's wrong.
  showToast(what && err.status !== 400 ? `${what}: ${msg}` : msg, 'error');
}

/**
 * Open /api/events and keep it open: on error, reconnect after 3 s, doubling
 * up to 30 s. onOpen({ reconnect }) fires on every successful (re)connect.
 */
export function connectEvents({ onMessage, onOpen, onDown }) {
  const MIN = 3000;
  const MAX = 30000;
  let es = null;
  let timer = 0;
  let delay = MIN;
  let opened = false;
  let paused = false;

  function open() {
    clearTimeout(timer);
    if (paused) return;
    es?.close();
    es = new EventSource('/api/events');
    es.onopen = () => {
      const reconnect = opened;
      opened = true;
      delay = MIN;
      onOpen?.({ reconnect });
    };
    es.onmessage = e => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      if (data && typeof data.type === 'string') onMessage(data);
    };
    es.onerror = () => {
      es?.close();
      es = null;
      if (paused) return;
      onDown?.(delay);
      timer = setTimeout(open, delay);
      delay = Math.min(delay * 2, MAX);
    };
  }

  open();
  return {
    /** Stop reconnect attempts (e.g. while the server restarts). */
    pause() { paused = true; clearTimeout(timer); es?.close(); es = null; },
    /** Reconnect immediately with the backoff reset. */
    resume() { paused = false; delay = MIN; open(); },
    close() { this.pause(); },
  };
}
