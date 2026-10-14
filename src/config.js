const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');

// Machine-specific overrides live in config.local.json next to package.json
// (gitignored — see config.local.example.json). Environment variables win over
// the file. Read once at startup; edit the file, then restart.
function loadLocalConfig() {
  const file = process.env.PROMO_CONFIG || path.join(APP_DIR, 'config.local.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Ignoring ${path.basename(file)}: ${err.message}`);
    return {};
  }
}
const LOCAL = loadLocalConfig();

// PROMO_DATA_DIR relocates all state (tests point it at a temp dir).
const DATA_DIR = process.env.PROMO_DATA_DIR || path.join(APP_DIR, 'data');
const ARCHIVE_DIR = process.env.PROMO_ARCHIVE_DIR
  || (process.env.PROMO_DATA_DIR ? path.join(DATA_DIR, 'archive') : path.join(APP_DIR, 'archive'));
const BROWSER_PROFILE_DIR = path.join(DATA_DIR, 'browser-profile');

const MINUTE = 60 * 1000;

// ── Apply-run budget ─────────────────────────────────────────────────────────
// A code gets one Postmates attempt and up to two Uber Eats attempts, each
// under CODE_ATTEMPT_MS (per-attempt deadlines); codes are spaced CODE_WAIT_MS apart. The run stops
// starting new codes once a worst-case code would no longer fit in the budget
// (the rest stay queued), and the outer deadline is the budget plus slack.
const MAX_CODES_PER_RUN = 5;
const CODE_WAIT_MS = 2 * MINUTE;
const CODE_ATTEMPT_MS = 4 * MINUTE;  // covers a confirmation re-apply too
const WORST_CASE_CODE_MS = CODE_ATTEMPT_MS * 3 + 30 * 1000;
const APPLY_BUDGET_MS = MAX_CODES_PER_RUN * WORST_CASE_CODE_MS + (MAX_CODES_PER_RUN - 1) * CODE_WAIT_MS;

module.exports = {
  APP_DIR,
  DATA_DIR,
  ARCHIVE_DIR,
  BROWSER_PROFILE_DIR,
  LOCAL,

  // State files — r/postmates monthly thread
  QUEUE_FILE: path.join(DATA_DIR, 'queue.txt'),
  PROCESSED_FILE: path.join(DATA_DIR, 'processed.txt'),
  THREAD_FILE: path.join(DATA_DIR, 'thread_config.txt'),
  THREAD_MONTH_FILE: path.join(DATA_DIR, 'last_thread_month.txt'),
  THREAD_DETECTED_FILE: path.join(DATA_DIR, 'last_thread_detected.txt'),
  TRIED_FILE: path.join(DATA_DIR, 'tried_codes.json'),
  LOG_FILE: path.join(DATA_DIR, 'run_log.jsonl'),
  SESSION_STATE_FILE: path.join(DATA_DIR, 'session_state.json'),
  CODE_CATALOG_FILE: path.join(DATA_DIR, 'code_catalog.json'),
  APPLIED_LEDGER_FILE: path.join(DATA_DIR, 'applied_codes.json'),
  SETTINGS_FILE: path.join(DATA_DIR, 'settings.json'),
  HEALTH_FILE: path.join(DATA_DIR, 'health.json'),
  HEARTBEAT_FILE: path.join(DATA_DIR, 'heartbeat.json'),
  LOCK_FILE: path.join(DATA_DIR, 'daemon.lock'),
  ACCESS_TOKEN_FILE: path.join(DATA_DIR, 'access_token'),
  DEBUG_DIR: path.join(DATA_DIR, 'debug-screenshots'),

  // State files — r/UberEATS monthly thread (shares queue + processed)
  UE_THREAD_FILE: path.join(DATA_DIR, 'ue_thread_config.txt'),
  UE_THREAD_MONTH_FILE: path.join(DATA_DIR, 'ue_last_thread_month.txt'),
  UE_THREAD_DETECTED_FILE: path.join(DATA_DIR, 'ue_last_thread_detected.txt'),
  UE_TRIED_FILE: path.join(DATA_DIR, 'ue_tried_codes.json'),

  // USCardForum "UberEATs/Postmates Coupon Codes" — a single long-running
  // Discourse topic (active since 2020, new codes most days). Its JSON API is
  // Cloudflare-gated for plain HTTP clients but works from inside our browser.
  USCF_TOPIC_ID: 15780,
  USCF_BASE_URL: 'https://www.uscardforum.com',
  USCF_STATE_FILE: path.join(DATA_DIR, 'uscf_state.json'),
  USCF_POSTS_PER_SCAN: 30,      // newest-unseen posts read per scan
  USCF_BACKLOG_LIMIT: 300,      // beyond this many unseen posts, skip ahead (logged)
  USCF_MAX_AGE_DAYS: 14,        // codes in older posts are almost always dead

  // Monthly-thread handoff: a 1–2 day late post is normal.
  STALE_THREAD_GRACE_DAYS: 3,
  EARLY_MONTH_DAYS: 5,

  // A code that landed on the account isn't re-queued for this long.
  REAPPLY_SKIP_DAYS: 14,

  // Apply automation
  MAX_CODES_PER_RUN,
  CODE_WAIT_MS,
  CODE_ATTEMPT_MS,
  WORST_CASE_CODE_MS,
  APPLY_BUDGET_MS,
  APPLY_DEADLINE_MS: APPLY_BUDGET_MS + 5 * MINUTE,
  SCAN_DEADLINE_MS: 10 * MINUTE,
  SESSION_CHECK_MS: 2 * MINUTE,
  LOGIN_TIMEOUT_MS: 15 * MINUTE,
  TRANSIENT_COOLDOWN_MS: 20 * 1000,
  // A code that errors (or can't be read) this many runs in a row gets a
  // final "rejected" verdict instead of being retried forever.
  MAX_TRANSIENT_FAILURES: 3,
  // Apply-on-arrival: at most one extra run per ARRIVAL_MIN_GAP_MS, none for
  // RATE_LIMIT_BACKOFF_MS after a run that hit the rate limiter.
  ARRIVAL_MIN_GAP_MS: 30 * MINUTE,
  RATE_LIMIT_BACKOFF_MS: 2 * 60 * MINUTE,

  PROMO_URL: 'https://postmates.com/feed?diningMode=DELIVERY&mod=promos&ps=1',
  // Uber Eats uses the same Uber feed promo modal as Postmates (separate login).
  // Codes rejected on Postmates (except "Code expired") are retried here.
  UBEREATS_PROMO_URL: 'https://www.ubereats.com/feed?diningMode=DELIVERY&mod=promos&ps=1',

  // Daily self-test + Uber Eats session check, in this Mac's local time.
  DAILY_CHECK_CRON: '45 4 * * *',
  DAILY_CHECK_LABEL: '4:45 AM',
  MAINTENANCE_CRON: '20 4 * * *',

  // Dashboard. Local-only by default. To reach it from your phone/laptop set
  // "host": "0.0.0.0" in config.local.json — other devices then need the
  // one-time access link (`npm run access-link`).
  DASHBOARD_PORT: parseInt(process.env.PORT, 10) || parseInt(LOCAL.port, 10) || 8766,
  DASHBOARD_HOST: process.env.HOST || LOCAL.host || '127.0.0.1',
  // Extra hostnames the dashboard may be opened under (e.g. a Tailscale
  // MagicDNS name). This machine's own names and IPs are always allowed.
  ALLOWED_HOSTS: [].concat(LOCAL.allowedHosts || []).map(h => String(h).toLowerCase()),
  ACCESS_TOKEN: process.env.PROMO_TOKEN || LOCAL.accessToken || null,

  SERVICE_LABEL: 'com.postmates.promo',
};
