const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const cfg = require('./config');
const { writeFileAtomic } = require('./atomic');
const { stateName } = require('./us-states');

const SERVICE_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${cfg.SERVICE_LABEL}.plist`);
const SETUP_STATUS_TTL_MS = 10_000;
let setupStatusCache = null;
let setupStatusCacheAt = 0;

const DEFAULTS = {
  scanIntervalHours: 2,
  applyIntervalHours: 4,
  // Home market. A promo localized to anywhere matching homeAliases (or to the
  // home state, or nationwide) is usable; anything else is region-locked and
  // excluded from savings. homeRegion is the human label used in messages;
  // empty means "not set yet" (the setup checklist asks for it).
  homeRegion: '',
  homeAliases: [],
  homeState: '',
};

const SCAN_INTERVALS = [0.5, 1, 2, 3, 4, 6, 12, 24];
const APPLY_INTERVALS = [1, 2, 3, 4, 6, 12, 24];

function normalizeInterval(value, allowed, fallback) {
  const n = Number(value);
  return allowed.includes(n) ? n : fallback;
}

function cleanText(value, max) {
  return String(value ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max);
}

// Aliases are lowercased, de-duped, and include the home region label itself
// so a plain "Chicago" location always matches a "Chicago" home.
function normalizeAliases(value, homeRegion) {
  let list = Array.isArray(value) ? value : String(value || '').split(',');
  const label = cleanText(homeRegion, 60).toLowerCase();
  list = [...list, label].map(a => cleanText(a, 60).toLowerCase()).filter(Boolean);
  return [...new Set(list)].slice(0, 30);
}

// "ca" / "california" → "California"; non-US input is kept as typed.
function normalizeState(value) {
  const name = stateName(value);
  if (name) return name.replace(/\b\w/g, c => c.toUpperCase());
  return cleanText(value, 40);
}

function normalize(raw) {
  const s = { ...DEFAULTS, ...raw };
  const homeRegion = cleanText(s.homeRegion, 60);
  return {
    scanIntervalHours: normalizeInterval(s.scanIntervalHours, SCAN_INTERVALS, DEFAULTS.scanIntervalHours),
    applyIntervalHours: normalizeInterval(s.applyIntervalHours, APPLY_INTERVALS, DEFAULTS.applyIntervalHours),
    homeRegion,
    homeAliases: homeRegion || (s.homeAliases || []).length ? normalizeAliases(s.homeAliases, homeRegion) : [],
    homeState: normalizeState(s.homeState),
  };
}

function load() {
  try {
    return normalize(JSON.parse(fs.readFileSync(cfg.SETTINGS_FILE, 'utf8')));
  } catch {
    return { ...DEFAULTS };
  }
}

// Validate a partial update. Returns { updates } or { error } — unknown keys
// are ignored, but a known key with a bad value is an error (not a silent no-op).
function validate(body = {}) {
  const updates = {};
  if (body.scanIntervalHours !== undefined) {
    const h = Number(body.scanIntervalHours);
    if (!SCAN_INTERVALS.includes(h)) return { error: `scanIntervalHours must be one of ${SCAN_INTERVALS.join(', ')}` };
    updates.scanIntervalHours = h;
  }
  if (body.applyIntervalHours !== undefined) {
    const h = Number(body.applyIntervalHours);
    if (!APPLY_INTERVALS.includes(h)) return { error: `applyIntervalHours must be one of ${APPLY_INTERVALS.join(', ')}` };
    updates.applyIntervalHours = h;
  }
  for (const key of ['homeRegion', 'homeState']) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== 'string') return { error: `${key} must be a string` };
      updates[key] = body[key];
    }
  }
  if (body.homeAliases !== undefined) {
    if (!Array.isArray(body.homeAliases) && typeof body.homeAliases !== 'string') {
      return { error: 'homeAliases must be a list or a comma-separated string' };
    }
    updates.homeAliases = body.homeAliases;
  }
  if (!Object.keys(updates).length) return { error: 'No valid fields provided' };
  return { updates };
}

function save(updates) {
  const current = load();
  const next = { ...current, ...updates };
  // Changing the home region without new aliases drops the old region's
  // aliases (they described the previous home).
  if (updates.homeRegion !== undefined && updates.homeAliases === undefined
      && cleanText(updates.homeRegion, 60).toLowerCase() !== current.homeRegion.toLowerCase()) {
    next.homeAliases = [];
  }
  const normalized = normalize(next);
  fs.mkdirSync(path.dirname(cfg.SETTINGS_FILE), { recursive: true });
  writeFileAtomic(cfg.SETTINGS_FILE, JSON.stringify(normalized, null, 2));
  invalidateSetupStatus();
  return normalized;
}

function hoursToCron(hours) {
  const n = parseFloat(hours);
  if (!isFinite(n) || n <= 0) return '0 */2 * * *'; // safe fallback
  if (n < 1) {
    // Fractional hours → minute-based cron (e.g. 0.5 → every 30 min)
    const mins = Math.round(n * 60);
    return `*/${mins} * * * *`;
  }
  const h = Math.round(n);
  if (h === 1) return '0 * * * *';
  if (h >= 24) return '0 0 * * *';
  return `0 */${h} * * *`;
}

function nextRunFromInterval(hours, now = new Date()) {
  const n = Number(hours);
  const next = new Date(now);
  next.setSeconds(0, 0);

  if (n < 1) {
    const mins = Math.round(n * 60);
    const nextMinute = Math.ceil((next.getMinutes() + 1) / mins) * mins;
    if (nextMinute >= 60) {
      next.setHours(next.getHours() + 1, 0, 0, 0);
    } else {
      next.setMinutes(nextMinute);
    }
    return next;
  }

  const h = Math.round(n);
  next.setMinutes(0, 0, 0);
  if (h >= 24) {
    next.setDate(next.getDate() + 1);
    next.setHours(0);
    return next;
  }

  const nextHour = Math.ceil((next.getHours() + 1) / h) * h;
  if (nextHour >= 24) {
    next.setDate(next.getDate() + 1);
    next.setHours(0);
  } else {
    next.setHours(nextHour);
  }
  return next;
}

// Cookie-presence hints (the real check is a live session probe). Reads the
// profile's Cookies SQLite DB with the system sqlite3 tool.
function countCookies(where) {
  const cookiePath = path.join(cfg.BROWSER_PROFILE_DIR, 'Default', 'Cookies');
  if (!fs.existsSync(cookiePath)) return null;
  try {
    const out = execFileSync('sqlite3', [cookiePath, `SELECT COUNT(*) FROM cookies WHERE ${where};`],
      { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return parseInt(out, 10) || 0;
  } catch {
    return undefined; // sqlite3 missing or DB locked
  }
}

// Postmates session cookie ('sid') or the Uber account cookie ('csid'). An
// unauthenticated visit only sets analytics cookies, not these.
function isLoggedIn() {
  const n = countCookies("(host_key LIKE '%postmates%' AND name='sid') OR (host_key LIKE '%uber%' AND name='csid')");
  if (n === null) return false;
  if (n === undefined) {
    // Fall back to a size heuristic (>50KB ≈ a real session).
    try { return fs.statSync(path.join(cfg.BROWSER_PROFILE_DIR, 'Default', 'Cookies')).size > 51200; }
    catch { return false; }
  }
  return n > 0;
}

// Uber Eats needs its own login session (the Uber SSO cookie doesn't carry to
// ubereats.com); an authenticated ubereats.com has a 'sid' cookie.
function isLoggedInUberEats() {
  return (countCookies("host_key LIKE '%ubereats%' AND name='sid'") || 0) > 0;
}

function isServiceInstalled() {
  return fs.existsSync(SERVICE_PLIST);
}

function getSetupStatus() {
  const now = Date.now();
  if (setupStatusCache && now - setupStatusCacheAt < SETUP_STATUS_TTL_MS) {
    return setupStatusCache;
  }
  const s = load();
  // A login counts as done when a real visit proved it works, or when its
  // cookie is there and no visit has proved it broken.
  const session = require('./session');
  const cookies = { postmates: isLoggedIn(), ubereats: isLoggedInUberEats() };
  const loginDone = (platform) => {
    const v = session.get(platform);
    return v === true || (v !== false && cookies[platform]);
  };

  const steps = [
    {
      id: 'login',
      label: 'Log in to Postmates',
      description: 'The app needs an active Postmates session to apply codes.',
      command: 'Settings → Log in to Postmates',
      hint: 'Opens Chrome on this Mac. Log in to Postmates, then close the window.',
      done: loginDone('postmates'),
      required: true,
    },
    {
      id: 'ubereats-login',
      label: 'Log in to Uber Eats',
      description: 'Codes Postmates rejects are retried on Uber Eats, which needs its own login.',
      command: 'Settings → Log in to Uber Eats',
      hint: 'Opens Chrome on this Mac. Log in to Uber Eats, then close the window.',
      done: loginDone('ubereats'),
      required: false,
    },
    {
      id: 'home-region',
      label: 'Set your home region',
      description: 'Promos locked to another city are marked region-locked and left out of your savings.',
      command: 'Settings → Home Region',
      hint: 'Enter your city (plus any nicknames) and your state. National promos always count.',
      done: !!s.homeRegion,
      required: true,
    },
    {
      id: 'service',
      label: 'Install background service',
      description: 'Start the app automatically when you log in to this Mac, without an open Terminal.',
      command: 'npm run install-service',
      hint: 'Installs a launchd agent; uninstall with npm run uninstall-service.',
      done: isServiceInstalled(),
      required: false,
    },
  ];

  const allRequiredDone = steps.filter(st => st.required).every(st => st.done);
  const allDone = steps.every(st => st.done);

  setupStatusCache = { steps, allRequiredDone, allDone, cookies };
  setupStatusCacheAt = now;
  return setupStatusCache;
}

function invalidateSetupStatus() {
  setupStatusCache = null;
  setupStatusCacheAt = 0;
}

// Gate for "apply on arrival": a scan just queued new codes → start an apply
// run now instead of waiting for the cron. Conservative about rate limits:
// never while a run is active, never within minGapMs of the last run that
// attempted codes, and never within backoffMs after a rate-limited run.
function shouldApplyOnArrival({
  queued, applyRunning, lastApplyAt, lastRateLimitedAt,
  now = Date.now(),
  minGapMs = cfg.ARRIVAL_MIN_GAP_MS,
  backoffMs = cfg.RATE_LIMIT_BACKOFF_MS,
}) {
  if (!queued || queued <= 0) return false;
  if (applyRunning) return false;
  if (lastRateLimitedAt && now - new Date(lastRateLimitedAt).getTime() < backoffMs) return false;
  if (lastApplyAt && now - new Date(lastApplyAt).getTime() < minGapMs) return false;
  return true;
}

module.exports = {
  load, save, validate, hoursToCron, nextRunFromInterval,
  normalizeInterval, SCAN_INTERVALS, APPLY_INTERVALS,
  shouldApplyOnArrival,
  isLoggedIn, isLoggedInUberEats, isServiceInstalled, getSetupStatus, invalidateSetupStatus,
  DEFAULTS, SERVICE_PLIST,
};
