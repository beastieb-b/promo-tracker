// Activity Log page.

import { state, subscribe } from './state.js';
import { $, escapeHtml as esc, cssToken, formatDateTime, patchHTML } from './util.js';

export function initLog() {
  subscribe('log', renderLog);
  subscribe('meta', renderLog);   // time zone may have changed
}

const EVENT_LABELS = {
  reddit_check_start: 'Scan started',
  reddit_check_done: 'Scan done',
  reddit_check_error: 'Scan error',
  reddit_check_fallback: 'Scan fallback',
  new_thread_detected: 'New monthly thread',
  thread_detect_older: 'Older thread ignored',
  thread_detect_browser: 'Thread found via browser (Reddit gate)',
  monthly_reset: 'Monthly reset',
  ue_monthly_reset: 'Monthly reset (r/UberEATS)',
  archive_warn: 'Archive warning',
  apply_run_start: 'Apply started',
  apply_run_done: 'Apply done',
  apply_run_error: 'Apply error',
  apply_stopped_for_time: 'Apply stopped (time limit)',
  apply_on_arrival: 'Instant apply (new codes)',
  apply_on_arrival_skipped: 'Instant apply deferred',
  code_result: 'Code result',
  code_deferred: 'Code deferred',
  code_skipped: 'Code skipped',
  confirm_pass: 'Double-check pass',
  applied_skip: 'Skipped — already on account',
  session_verified: 'Session check',
  sso_relogin: 'Auto sign-in (pressed Log in)',
  login_timeout: 'Login window timed out',
  reddit_fetch_browser: 'Comments via browser (Reddit gate)',
  reddit_empty_thread_anomaly: 'Thread unreadable — Reddit blocking',
  modal_reopen: 'Modal closed mid-entry — reopened',
  forum_check_done: 'Scan done (forum)',
  forum_check_error: 'Forum scan error',
  forum_backlog_skipped: 'Forum backlog skipped',
  run_deadline: 'Run overran — browser recycled',
  ubereats_parked: 'Held for Uber Eats (logged out)',
  ubereats_requeue: 'Requeued for Uber Eats',
  ubereats_fallback: 'Uber Eats fallback',
  ubereats_fallback_retry: 'Uber Eats retry (transient error)',
  rate_limited: 'Rate limited',
  detection_health_warning: 'Health warning',
  self_test: 'Self-test',
  access_denied: 'Remote access denied',
};

export const eventLabel = type => EVENT_LABELS[type] || String(type || 'event');

// Machine reasons -> human phrasing. Unmapped reasons fall through as
// "reason: X" so nothing is silently dropped.
const REASON_LABELS = {
  no_pending_codes: 'no codes in queue — nothing to do',
  not_logged_in: 'login needed',
};

function formatLogDetail(entry) {
  const parts = [];
  if (entry.source) parts.push(`source: ${entry.source}`);
  if (entry.thread_id) parts.push(`thread: ${entry.thread_id}`);
  if (entry.comments_scanned) parts.push(`${entry.comments_scanned} comments`);
  if (entry.posts_scanned !== undefined) parts.push(`${entry.posts_scanned} new posts`);
  if (entry.new_codes !== undefined) parts.push(`${entry.new_codes} new codes`);
  if (entry.queued !== undefined) parts.push(`${entry.queued} queued`);
  if (entry.applied !== undefined) parts.push(`${entry.applied} applied`);
  if (entry.code) parts.push(`code: ${entry.code}`);
  if (Array.isArray(entry.codes)) parts.push(entry.codes.join(', '));
  if (entry.platform) parts.push(/ubereats/i.test(entry.platform) ? 'Uber Eats' : 'Postmates');
  if (entry.target) parts.push(/ubereats/i.test(entry.target) ? 'Uber Eats' : 'Postmates');
  if (entry.result) parts.push(entry.result);
  if (typeof entry.ok === 'boolean') parts.push(entry.ok ? 'ok ✓' : 'failed ✗');
  if (entry.outcome) parts.push(entry.outcome);
  if (entry.reason) parts.push(REASON_LABELS[entry.reason] || `reason: ${entry.reason}`);
  if (entry.note) parts.push(entry.note);
  if (entry.message) parts.push(entry.message);
  if (entry.error) parts.push(`ERROR: ${entry.error}`);
  if (entry.detail) parts.push(entry.detail);
  if (entry.old_thread) parts.push(`${entry.old_thread} → ${entry.new_thread}`);
  return parts.join(' · ') || '—';
}

export function renderLog() {
  const el = $('log-container');
  if (!el || !state.logLoaded) return;
  if (!state.logs.length) {
    patchHTML(el, '<div class="empty-state">No log entries yet</div>');
    return;
  }
  patchHTML(el, state.logs.map(entry => {
    const ts = formatDateTime(entry.ts, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const detail = formatLogDetail(entry);
    return `<div class="log-entry">
      <span class="log-ts">${esc(ts)}</span>
      <span class="log-type ${cssToken(entry.type)}">${esc(eventLabel(entry.type))}</span>
      <span class="log-detail" title="${esc(detail)}">${esc(detail)}</span>
    </div>`;
  }).join(''));
}
