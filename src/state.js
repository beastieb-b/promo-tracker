const fs = require('fs');
const cfg = require('./config');
const { writeFileAtomic } = require('./atomic');
const { monthKey } = require('./time');

function ensureDirs() {
  [cfg.DATA_DIR, cfg.ARCHIVE_DIR, cfg.BROWSER_PROFILE_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// ── Codes & catalog (shared by every account) ────────────────────────────────

function normalizeCode(code) {
  if (typeof code !== 'string') return null;
  const normalized = code.trim().toUpperCase();
  return /^[A-Z0-9_-]{4,32}$/.test(normalized) ? normalized : null;
}

function getCodeCatalog() {
  const parsed = readJson(cfg.CODE_CATALOG_FILE, {});
  return { codes: parsed.codes || {}, sources: parsed.sources || {} };
}

function saveCodeCatalog(catalog) {
  writeFileAtomic(cfg.CODE_CATALOG_FILE, JSON.stringify(catalog, null, 2));
}

function mergeCodeMeta(code, meta = {}) {
  const normalized = normalizeCode(code);
  if (!normalized) return false;
  const catalog = getCodeCatalog();
  catalog.codes[normalized] = {
    ...(catalog.codes[normalized] || {}),
    ...meta,
    code: normalized,
    updatedAt: new Date().toISOString(),
  };
  saveCodeCatalog(catalog);
  return true;
}

function setSourceStatus(sourceKey, status = {}) {
  const catalog = getCodeCatalog();
  catalog.sources[sourceKey] = {
    ...(catalog.sources[sourceKey] || {}),
    ...status,
    updatedAt: new Date().toISOString(),
  };
  saveCodeCatalog(catalog);
}

// ── Result rows (parsing helpers; each account's results live in store.js) ────
// processed.txt: CODE\tresult\tdetail\ttimestamp (legacy rows: CODE:result)

function parseProcessedLine(line) {
  if (line.includes('\t')) {
    const [code, result, detail, ts] = line.split('\t');
    return { code, result, detail: detail || null, ts: ts || null };
  }
  const idx = line.lastIndexOf(':');
  if (idx === -1) return null;
  return { code: line.slice(0, idx), result: line.slice(idx + 1), detail: null, ts: null };
}

function readProcessedFile(file) {
  return (readText(file) || '').split('\n').map(l => l.trim()).filter(Boolean)
    .map(parseProcessedLine).filter(Boolean);
}

// "$20" from "$20 off", "10%" from "10% off"; null when there's no amount.
function amountOf(detail) {
  const d = String(detail || '');
  const dollar = d.match(/\$\s*(\d+(?:\.\d+)?)/);
  if (dollar) return '$' + dollar[1];
  const pct = d.match(/(\d+)\s*%/);
  return pct ? pct[1] + '%' : null;
}

// Where a region-locked promo works, from either detail format:
//   apply-time  "$10 off — Las Vegas only"
//   scan hint   "LV-only — not valid in Chicago"
function locationOf(detail) {
  const d = String(detail || '');
  const a = d.match(/—\s*(.+?)\s*only\b/i);
  if (a) return a[1].trim();
  const b = d.match(/^\s*([a-z .'-]+?)-only/i);
  return b ? b[1].trim() : null;
}

// Which site a result came from. The detail is per attempt ("… · UberEats"
// marks the Uber Eats fallback); the catalog's appliedOn is not — it keeps an
// earlier cycle's platform.
function platformOf(row) {
  return /·\s*UberEats\b/i.test(row.detail || '') ? 'ubereats' : 'postmates';
}

const isAlreadyApplied = (r) => /^Already applied/.test(r.detail || '');

// ── USCardForum high-water mark ──────────────────────────────────────────────
// The forum topic never rolls over (one thread since 2020), so instead of the
// per-thread tried sets Reddit uses, we remember the newest post id already
// scanned; each scan reads only posts newer than it.
function getUSCFState() {
  return readJson(cfg.USCF_STATE_FILE, { lastSeenId: 0 });
}

function saveUSCFState(s) {
  writeFileAtomic(cfg.USCF_STATE_FILE, JSON.stringify(s, null, 2));
}

// ── Tried codes (codes found in a monthly thread, avoids re-queuing) ─────────

function getTriedState() {
  return readJson(cfg.TRIED_FILE, { thread_id: '', tried_codes: [], successful_codes: [], failed_codes: [] });
}

function saveTriedState(s) {
  writeFileAtomic(cfg.TRIED_FILE, JSON.stringify(s, null, 2));
}

// ── Thread config ────────────────────────────────────────────────────────────

const readTrimmed = (file) => (readText(file) || '').trim() || null;

function getThreadId() { return readTrimmed(cfg.THREAD_FILE); }
function getThreadMonth() { return readTrimmed(cfg.THREAD_MONTH_FILE); }
function getThreadDetectedAt() { return readTrimmed(cfg.THREAD_DETECTED_FILE); }
function getUEThreadId() { return readTrimmed(cfg.UE_THREAD_FILE); }
function getUEThreadMonth() { return readTrimmed(cfg.UE_THREAD_MONTH_FILE); }
function getUEThreadDetectedAt() { return readTrimmed(cfg.UE_THREAD_DETECTED_FILE); }

function saveThreadId(id, month) {
  writeFileAtomic(cfg.THREAD_FILE, id);
  writeFileAtomic(cfg.THREAD_MONTH_FILE, month);
}

function saveUEThreadId(id, month) {
  writeFileAtomic(cfg.UE_THREAD_FILE, id);
  writeFileAtomic(cfg.UE_THREAD_MONTH_FILE, month);
}

// Per-source state of the monthly-thread handoff, for the dashboard:
//   'found'   — the current month's thread is loaded
//   'waiting' — still on last month's thread but within the grace window
//   'stale'   — still on last month's thread past the grace window (a problem)
//   'unknown' — no thread/month recorded yet
function computeThreadState(month, currentMonth, day) {
  if (!month) return 'unknown';
  if (month >= currentMonth) return 'found';
  return day >= cfg.STALE_THREAD_GRACE_DAYS ? 'stale' : 'waiting';
}

// Month and day both come from the local calendar, the same clock the stored
// thread month is written in.
function getThreadFreshness(now = new Date()) {
  const day = now.getDate();
  const currentMonth = monthKey(now);
  const sources = [
    { label: 'r/postmates', subreddit: 'postmates', threadId: getThreadId(), month: getThreadMonth(), detectedAt: getThreadDetectedAt() },
    { label: 'r/UberEATS', subreddit: 'UberEATS', threadId: getUEThreadId(), month: getUEThreadMonth(), detectedAt: getUEThreadDetectedAt() },
  ].map(s => ({ ...s, state: computeThreadState(s.month, currentMonth, day) }));
  return { currentMonth, day, earlyMonth: day <= cfg.EARLY_MONTH_DAYS, graceDays: cfg.STALE_THREAD_GRACE_DAYS, sources };
}

// ── Monthly reset ─────────────────────────────────────────────────────────────
// Called when a NEWER r/postmates monthly thread is detected. Every account
// archives this cycle's results and the codes it queued before the current
// calendar month (last month's codes have mostly expired); codes queued this
// month — from r/UberEATS, the forum, or by hand — stay queued.

function monthlyReset(oldThreadId, newThreadId, newMonth, now = new Date()) {
  const { store } = require('./store');
  const kept = {};
  for (const account of require('./accounts').list()) {
    kept[account.id] = store(account).monthlyArchive(oldThreadId, now);
  }
  saveTriedState({ thread_id: newThreadId, tried_codes: [], successful_codes: [], failed_codes: [] });
  saveThreadId(newThreadId, newMonth);
  writeFileAtomic(cfg.THREAD_DETECTED_FILE, now.toISOString());
  appendLog({ type: 'monthly_reset', old_thread: oldThreadId, new_thread: newThreadId, month: newMonth, kept_queued: kept });
}

function ueMonthlyReset(oldThreadId, newThreadId, newMonth, now = new Date()) {
  saveUETriedState({ thread_id: newThreadId, tried_codes: [] });
  saveUEThreadId(newThreadId, newMonth);
  writeFileAtomic(cfg.UE_THREAD_DETECTED_FILE, now.toISOString());
  appendLog({ type: 'ue_monthly_reset', old_thread: oldThreadId, new_thread: newThreadId, month: newMonth });
}

function getUETriedState() {
  return readJson(cfg.UE_TRIED_FILE, { thread_id: '', tried_codes: [] });
}

function saveUETriedState(s) {
  writeFileAtomic(cfg.UE_TRIED_FILE, JSON.stringify(s, null, 2));
}

// ── Log ─────────────────────────────────────────────────────────────────────

function appendLog(entry) {
  // Logging must never take down a scan/apply run.
  try {
    fs.appendFileSync(cfg.LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (err) {
    console.error('appendLog failed:', err.message);
  }
}

function getLog(limit = 200) {
  const lines = (readText(cfg.LOG_FILE) || '').split('\n').filter(Boolean);
  return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
}

// ── Health warning (one banner slot, tagged by source) ──────────────────────

function setHealthWarning(message, source = 'general') {
  writeFileAtomic(cfg.HEALTH_FILE, JSON.stringify({ message, source, ts: new Date().toISOString() }));
}

function getHealthWarning() {
  return readJson(cfg.HEALTH_FILE, null);
}

function clearHealthWarning() {
  try { fs.unlinkSync(cfg.HEALTH_FILE); } catch {}
}

// ── Heartbeat (persisted last-success times for the staleness watchdog) ──────

function getHeartbeat() {
  return readJson(cfg.HEARTBEAT_FILE, {});
}

// kind: 'scan' | 'apply' | 'codeApply' | 'ratelimited'
function recordHeartbeat(kind) {
  const hb = getHeartbeat();
  hb[kind] = new Date().toISOString();
  writeFileAtomic(cfg.HEARTBEAT_FILE, JSON.stringify(hb));
}

// ── Savings ──────────────────────────────────────────────────────────────────

// Dollar amount in a result detail like "$20 off" or "Save $15". Percentage
// promos ("10% off") have no fixed dollar value, so they count as 0.
function parseSavings(detail) {
  if (!detail) return 0;
  const m = String(detail).match(/\$\s*(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

function sumSavings(successes) {
  return successes.reduce((acc, r) => acc + parseSavings(r.detail), 0);
}

// Forget that a code was seen in this month's threads, so the next scan can
// queue it again (used when a result is deleted or retried).
function forgetSeen(code) {
  const tried = getTriedState();
  for (const k of ['tried_codes', 'successful_codes', 'failed_codes', 'skipped_applied']) {
    tried[k] = (tried[k] || []).filter(c => c !== code);
  }
  saveTriedState(tried);
  const ueTried = getUETriedState();
  for (const k of ['tried_codes', 'skipped_applied']) {
    ueTried[k] = (ueTried[k] || []).filter(c => c !== code);
  }
  saveUETriedState(ueTried);
}

module.exports = {
  ensureDirs, readText, readJson,
  normalizeCode,
  getCodeCatalog, saveCodeCatalog, mergeCodeMeta, setSourceStatus,
  parseProcessedLine, readProcessedFile, amountOf, locationOf, platformOf, isAlreadyApplied,
  getTriedState, saveTriedState, forgetSeen,
  getThreadId, getThreadMonth, saveThreadId,
  getThreadDetectedAt, getUEThreadDetectedAt,
  getThreadFreshness, computeThreadState,
  monthlyReset,
  getUEThreadId, getUEThreadMonth, saveUEThreadId,
  getUETriedState, saveUETriedState,
  ueMonthlyReset,
  appendLog, getLog,
  getUSCFState, saveUSCFState,
  setHealthWarning, getHealthWarning, clearHealthWarning,
  getHeartbeat, recordHeartbeat,
  parseSavings, sumSavings,
};
