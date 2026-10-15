// Small, dependency-free helpers: escaping, URL checks, formatting, DOM.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape any value for use in HTML text or a quoted attribute. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ESCAPES[ch]);
}

/** Reduce a value to a safe CSS class token. */
export function cssToken(value) {
  return String(value || '').replace(/[^a-z0-9_-]/gi, '');
}

/** Only absolute http(s) URLs pass; anything else (javascript:, data:, relative, junk) -> null. */
export function safeUrl(u) {
  if (typeof u !== 'string') return null;
  const s = u.trim();
  if (!s) return null;
  let url;
  try { url = new URL(s); } catch { return null; }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
}

/** Link + tooltip for a queue/result row, based on where the code came from. */
export function sourceLink(item) {
  const key = String(item?.sourceKey || '');
  if (!key || key === 'manual') return null;
  if (key === 'uscf') {
    const href = safeUrl(item.commentUrl) || safeUrl(item.sourceUrl);
    return href ? { href, title: 'Open the forum post' } : null;
  }
  if (key.startsWith('reddit')) {
    const comment = safeUrl(item.commentUrl);
    if (comment) return { href: comment, title: 'Open the Reddit comment' };
    const thread = safeUrl(item.sourceUrl);
    return thread ? { href: thread, title: 'Open the Reddit thread' } : null;
  }
  const href = safeUrl(item.commentUrl) || safeUrl(item.sourceUrl);
  return href ? { href, title: 'Open the source' } : null;
}

/** <a> markup for an external link (href must already be safeUrl()-checked). */
export function externalLink(href, text, { cls = 'source-link', title = '' } = {}) {
  const t = title ? ` title="${escapeHtml(title)}"` : '';
  return `<a class="${escapeHtml(cls)}" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${t}>${escapeHtml(text)}</a>`;
}

/* ── Dates & durations ───────────────────────────────────────────────────── */

/** Parse anything date-like; invalid/missing -> null. */
export function toDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "5m ago" / "3h 12m ago" / "2d ago"; invalid -> "—"; future (clock skew) -> "just now". */
export function timeAgo(v) {
  const d = toDate(v);
  if (!d) return '—';
  const diff = Date.now() - d.getTime();
  if (diff < 60000) return 'just now';
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** 90 min -> "1h 30m"; 50 h -> "2d 2h". Negative/invalid -> "0m". */
export function formatDuration(ms) {
  const n = Number(ms);
  const total = Number.isFinite(n) && n > 0 ? n : 0;
  const m = Math.floor(total / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h >= 48) {
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh ? `${d}d ${rh}h` : `${d}d`;
  }
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

/** "in 1h 5m" / "any moment" for a future timestamp; null when invalid. */
export function untilText(v) {
  const d = toDate(v);
  if (!d) return null;
  const diff = d.getTime() - Date.now();
  return diff > 0 ? `in ${formatDuration(diff)}` : 'any moment';
}

/** 120000 -> "2 minutes", 90000 -> "90 seconds". */
export function formatWait(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const s = Math.round(n / 1000);
  if (s < 60 || s % 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = s / 60;
  return `${m} minute${m === 1 ? '' : 's'}`;
}

/** Short interval label: 0.5 -> "30m", 2 -> "2h". */
export function formatInterval(hours) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return '—';
  return h < 1 ? `${Math.round(h * 60)}m` : `${h}h`;
}

/** Select-option label: 0.5 -> "Every 30 minutes", 1 -> "Every hour", 24 -> "Once a day". */
export function intervalLabel(hours) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return String(hours);
  if (h === 24) return 'Once a day';
  if (h === 1) return 'Every hour';
  if (h < 1) return `Every ${Math.round(h * 60)} minutes`;
  return `Every ${h} hours`;
}

// Absolute timestamps are shown in the Mac's time zone (meta.timezone) so the
// log, the daily check time and "detected at" all agree, whatever device views them.
let displayTimeZone;
export function setDisplayTimeZone(tz) {
  displayTimeZone = undefined;
  if (typeof tz !== 'string' || !tz) return;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    displayTimeZone = tz;
  } catch { /* unknown zone: fall back to the browser's */ }
}

export function formatDateTime(v, opts) {
  const d = toDate(v);
  if (!d) return '—';
  return d.toLocaleString('en-US', displayTimeZone ? { ...opts, timeZone: displayTimeZone } : opts);
}

/** 'YYYY-MM' -> "October 2026" ('' when invalid). */
export function formatMonth(m, style = 'long') {
  const match = /^(\d{4})-(\d{2})$/.exec(String(m || ''));
  if (!match) return '';
  const d = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  return style === 'short'
    ? d.toLocaleString('en-US', { month: 'short' })
    : d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

/** 'YYYY-MM-DD' -> "October 1, 2026" (no time-zone shift); null when invalid. */
export function formatDay(s) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  if (!match) return null;
  const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/* ── Numbers & words ─────────────────────────────────────────────────────── */

/** "$20" / "$12.50" — drops ".00" on whole-dollar amounts. */
export function formatMoney(n) {
  const v = Number(n) || 0;
  return '$' + (Number.isInteger(v) ? v : v.toFixed(2));
}

export function plural(n, word, many = `${word}s`) {
  return `${n} ${n === 1 ? word : many}`;
}

export const platformName = p => (p === 'ubereats' ? 'Uber Eats' : 'Postmates');

/* ── DOM ─────────────────────────────────────────────────────────────────── */

export const $ = id => document.getElementById(id);

export function setText(id, value) {
  const el = typeof id === 'string' ? $(id) : id;
  if (el && el.textContent !== String(value)) el.textContent = value;
}

export function show(el, visible) {
  const node = typeof el === 'string' ? $(el) : el;
  if (node) node.hidden = !visible;
}

const BADGE_CLASSES = ['badge-ok', 'badge-info', 'badge-warn', 'badge-error', 'badge-running', 'badge-muted'];

/** Card badge text + state class (login, self-test, remote access, accounts). */
export function setBadge(el, text, cls) {
  if (!el) return;
  setText(el, text);
  el.classList.remove(...BADGE_CLASSES);
  if (cls) el.classList.add(cls);
}

const lastHtml = new WeakMap();

/**
 * Replace an element's markup only when it actually changed, so 30-second
 * polls don't reset scroll position, hover state or keyboard focus. If focus
 * was inside, it is restored to the element with the same data-focus-key.
 */
export function patchHTML(el, html) {
  if (!el || lastHtml.get(el) === html) return false;
  const active = document.activeElement;
  const focusKey = active && el.contains(active) ? active.getAttribute('data-focus-key') : null;
  const scrollTop = el.scrollTop;
  el.innerHTML = html;
  lastHtml.set(el, html);
  if (el.scrollTop !== scrollTop) el.scrollTop = scrollTop;
  if (focusKey) {
    const next = [...el.querySelectorAll('[data-focus-key]')].find(n => n.getAttribute('data-focus-key') === focusKey);
    next?.focus({ preventScroll: true });
  }
  return true;
}

/** Clipboard write; falls back to execCommand (plain-http LAN access has no async clipboard API). */
export async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch { /* permission denied or not focused: try the legacy path */ }
  }
  const active = document.activeElement;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.className = 'clipboard-helper';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  if (active instanceof HTMLElement) active.focus({ preventScroll: true });
  if (!ok) throw new Error('Clipboard blocked');
}

/* ── Result vocabulary ───────────────────────────────────────────────────── */

const RESULT_LABELS = {
  success: 'Success', rejected: 'Rejected', ratelimited: 'Rate Limited',
  error: 'Error', unknown: 'Unknown', region_skip: 'Region Locked',
};
const RESULT_ICONS = {
  success: '✅', rejected: '❌', ratelimited: '⏳', error: '⚠️', unknown: '❓', region_skip: '📍',
};
export const resultLabel = r => RESULT_LABELS[r] || String(r || 'Unknown');
export const resultIcon = r => RESULT_ICONS[r] || '•';
