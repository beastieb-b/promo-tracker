const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { writeFileAtomic } = require('./atomic');
const { monthKey, previousMonthKey, monthStartMs, dateKey } = require('./time');

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

// ── Queue (codes waiting to be applied) ─────────────────────────────────────

function getQueue() {
  return (readText(cfg.QUEUE_FILE) || '').split('\n').map(l => l.trim()).filter(Boolean);
}

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

function addToQueue(entries) {
  const existing = new Set(getQueue());
  const processed = new Set(getProcessed().map(r => r.code));
  const catalog = getCodeCatalog();
  const deduped = new Map();
  for (const raw of entries) {
    const entry = typeof raw === 'string' ? { code: raw } : raw;
    const code = normalizeCode(entry && entry.code);
    if (code) deduped.set(code, { ...entry, code });
  }
  const newEntries = [...deduped.values()].filter(e => !existing.has(e.code) && !processed.has(e.code));
  if (!newEntries.length) return 0;
  // Only NEW codes get catalog metadata: a second sighting (another thread, or
  // the forum) must not overwrite the first source's attribution and link.
  const now = new Date().toISOString();
  for (const entry of newEntries) {
    catalog.codes[entry.code] = {
      ...(catalog.codes[entry.code] || {}),
      ...entry,
      code: entry.code,
      queuedAt: now,
      updatedAt: now,
    };
  }
  saveCodeCatalog(catalog);
  fs.appendFileSync(cfg.QUEUE_FILE, newEntries.map(e => e.code).join('\n') + '\n');
  return newEntries.length;
}

function writeQueue(codes) {
  writeFileAtomic(cfg.QUEUE_FILE, codes.join('\n') + (codes.length ? '\n' : ''));
}

function removeFromQueue(code) {
  const normalized = normalizeCode(code);
  if (!normalized) return false;
  const queue = getQueue();
  if (!queue.includes(normalized)) return false;
  writeQueue(queue.filter(c => c !== normalized));
  return true;
}

// Order in which an apply run tries queued codes: codes added by hand first,
// then codes containing digits (far more likely to be real promo codes than a
// stray word), then higher confidence, then most recently seen. Nothing is
// ever skipped — lower-ranked codes are simply tried on later runs.
function rankQueue(entries) {
  return entries
    .map(e => ({
      e,
      score: (e.manual ? 2000 : 0) + (/\d/.test(e.code) ? 1000 : 0) + (Number(e.confidenceScore) || 0),
      seen: Date.parse(e.lastSeenAt || '') || 0,
    }))
    .sort((a, b) => (b.score - a.score) || (b.seen - a.seen))
    .map(({ e }, i) => ({ ...e, priority: i + 1 }));
}

function getQueueDetails() {
  const catalog = getCodeCatalog();
  return rankQueue(getQueue().map(code => ({ ...(catalog.codes[code] || {}), code })));
}

// ── Processed results ────────────────────────────────────────────────────────
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

function getProcessed() {
  return readProcessedFile(cfg.PROCESSED_FILE);
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

// Results shown on the dashboard: this cycle's processed.txt plus anything a
// monthly reset already archived from the current calendar month (so a reset
// on the 3rd doesn't hide the 1st and 2nd). Oldest first.
function getProcessedDetails(now = new Date()) {
  const catalog = getCodeCatalog();
  const month = monthKey(now);
  const archived = archiveData().rows
    .filter(r => r.ts && monthKey(r.ts) === month)
    .map(r => ({ ...r, archived: true }));
  const rows = [...archived, ...getProcessed()]
    .sort((a, b) => (a.ts || '') < (b.ts || '') ? -1 : (a.ts || '') > (b.ts || '') ? 1 : 0);
  return rows.map(item => {
    const row = { ...(catalog.codes[item.code] || {}), ...item };
    return {
      ...row,
      platform: platformOf(row),
      amount: isAlreadyApplied(row) ? null : amountOf(row.detail),
      location: row.result === 'region_skip' ? locationOf(row.detail) : null,
    };
  });
}

// Rewrite one code's result rows wherever the dashboard shows them:
// processed.txt, plus this calendar month's rows in archive files.
// fn(row) returns a replacement line, null to delete the row, or undefined to
// keep it. Returns how many rows fn changed.
function editResultRows(code, fn, now = new Date()) {
  const month = monthKey(now);
  let changed = 0;
  const editFile = (file, onlyThisMonth) => {
    const text = readText(file);
    if (text === null) return false;
    let touched = false;
    const out = [];
    for (const line of text.split('\n').filter(Boolean)) {
      const row = parseProcessedLine(line.trim());
      const eligible = row && row.code === code && (!onlyThisMonth || (row.ts && monthKey(row.ts) === month));
      const next = eligible ? fn(row) : undefined;
      if (next === undefined) { out.push(line); continue; }
      touched = true;
      changed++;
      if (next !== null) out.push(next);
    }
    if (touched) writeFileAtomic(file, out.join('\n') + (out.length ? '\n' : ''));
    return touched;
  };
  editFile(cfg.PROCESSED_FILE, false);
  let archiveTouched = false;
  try {
    for (const f of fs.readdirSync(cfg.ARCHIVE_DIR)) {
      if (/-processed(-\d+)?\.txt$/.test(f) && editFile(path.join(cfg.ARCHIVE_DIR, f), true)) archiveTouched = true;
    }
  } catch {}
  if (archiveTouched) invalidateArchiveCache();
  return changed;
}

// Forget a code entirely: its result row, its tried-state entries and its
// applied-ledger entry, so the next scan can queue it again.
function deleteResult(code) {
  const normalized = normalizeCode(code);
  if (!normalized) return false;

  const found = editResultRows(normalized, () => null) > 0;

  const tried = getTriedState();
  tried.tried_codes = (tried.tried_codes || []).filter(c => c !== normalized);
  tried.successful_codes = (tried.successful_codes || []).filter(c => c !== normalized);
  tried.failed_codes = (tried.failed_codes || []).filter(c => c !== normalized);
  tried.skipped_applied = (tried.skipped_applied || []).filter(c => c !== normalized);
  saveTriedState(tried);

  const ueTried = getUETriedState();
  ueTried.tried_codes = (ueTried.tried_codes || []).filter(c => c !== normalized);
  ueTried.skipped_applied = (ueTried.skipped_applied || []).filter(c => c !== normalized);
  saveUETriedState(ueTried);

  forgetApplied(normalized);
  return found;
}

function markResult(code, result, detail = null) {
  const normalized = normalizeCode(code);
  if (!normalized) return false;
  removeFromQueue(normalized);
  const safeDetail = detail ? String(detail).replace(/[\t\n\r]/g, ' ').slice(0, 120) : '';
  fs.appendFileSync(cfg.PROCESSED_FILE, `${normalized}\t${result}\t${safeDetail}\t${new Date().toISOString()}\n`);
  // Success AND region_skip both mean the code landed on the account — record
  // them so a scan won't re-queue the code while it's still sitting there.
  if (result === 'success' || result === 'region_skip') recordApplied(normalized);
  // A hand-added code jumps the queue once, not again if a scan finds it
  // later; a settled code starts its failure count over if it ever returns.
  const meta = getCodeCatalog().codes[normalized] || {};
  if (meta.manual || meta.transientFailures || meta.confirmPending) {
    mergeCodeMeta(normalized, { manual: false, transientFailures: 0, confirmPending: false });
  }
  return true;
}

// ── Applied-codes ledger ─────────────────────────────────────────────────────
// Codes that actually landed on the account (success or region_skip), with when.
// Scans skip re-queueing a code applied within REAPPLY_SKIP_DAYS — e.g. after
// the monthly reset, last cycle's wins would otherwise be re-tried and burn an
// apply slot on "Oops, you already applied this promotion". Past the window
// the code is eligible again (promos do get refreshed).

function loadAppliedLedger() {
  return readJson(cfg.APPLIED_LEDGER_FILE, {});
}

function saveAppliedLedger(ledger) {
  writeFileAtomic(cfg.APPLIED_LEDGER_FILE, JSON.stringify(ledger, null, 2));
}

function recordApplied(code, ts = new Date().toISOString()) {
  const ledger = loadAppliedLedger();
  ledger[code] = ts;
  // Prune entries old enough that they can never matter again.
  const cutoff = Date.now() - cfg.REAPPLY_SKIP_DAYS * 2 * 86400000;
  for (const [c, t] of Object.entries(ledger)) {
    const ms = new Date(t).getTime();
    if (isNaN(ms) || ms < cutoff) delete ledger[c];
  }
  saveAppliedLedger(ledger);
}

function forgetApplied(code) {
  const ledger = loadAppliedLedger();
  if (!(code in ledger)) return;
  delete ledger[code];
  saveAppliedLedger(ledger);
}

// Set of codes applied within the last `days`. `ledger` is injectable for tests.
function getRecentlyApplied(days = cfg.REAPPLY_SKIP_DAYS, ledger = loadAppliedLedger(), now = Date.now()) {
  const cutoff = now - days * 86400000;
  const out = new Set();
  for (const [code, ts] of Object.entries(ledger)) {
    const ms = new Date(ts).getTime();
    if (!isNaN(ms) && ms >= cutoff) out.add(code);
  }
  return out;
}

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

// Put a processed code back in the queue to be tried again (the "Retry"
// action, and Uber Eats retries after a login comes back).
function requeueResult(code) {
  const normalized = normalizeCode(code);
  if (!normalized) return false;
  deleteResult(normalized);
  const meta = getCodeCatalog().codes[normalized] || {};
  addToQueue([{ ...meta, code: normalized }]);
  return true;
}

// Correct a processed code's verdict in place (keeps its timestamp): flag a
// success as region-locked (so it stops counting) or count one back. The
// detail is rebuilt from the existing amount.
function reclassifyResult(code, newResult) {
  const normalized = normalizeCode(code);
  if (!normalized || !['success', 'region_skip'].includes(newResult)) return false;
  // Only rows where the code landed (a success or region-locked) flip.
  const changed = editResultRows(normalized, (row) => {
    if (row.result !== 'success' && row.result !== 'region_skip') return undefined;
    const amount = amountOf(row.detail);
    const suffix = platformOf(row) === 'ubereats' ? ' · UberEats' : '';
    const detail = newResult === 'region_skip'
      ? `${amount ? amount + ' off' : 'Applied'} — region-locked${suffix}`
      : `${amount ? amount + ' off' : 'Applied!'}${suffix}`;
    return [normalized, newResult, detail, row.ts || new Date().toISOString()].join('\t');
  });
  if (!changed) return false;
  mergeCodeMeta(normalized, { regionRestricted: newResult === 'region_skip' });
  return true;
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
// Called when a NEWER r/postmates monthly thread is detected. Archives this
// cycle's results and the codes queued before the current calendar month
// (last month's codes have mostly expired). Codes queued this month — from the
// r/UberEATS thread, the forum, or by hand — stay queued: the queue is shared
// by every source, not owned by the r/postmates thread.

function uniqueArchivePath(stamp, threadId, suffix) {
  const base = `${stamp}-${threadId || 'unknown'}-${suffix}`;
  let dest = path.join(cfg.ARCHIVE_DIR, `${base}.txt`);
  for (let n = 2; fs.existsSync(dest); n++) dest = path.join(cfg.ARCHIVE_DIR, `${base}-${n}.txt`);
  return dest;
}

function monthlyReset(oldThreadId, newThreadId, newMonth, now = new Date()) {
  const stamp = dateKey(now);
  fs.mkdirSync(cfg.ARCHIVE_DIR, { recursive: true });

  try {
    if (fs.existsSync(cfg.PROCESSED_FILE)) {
      fs.copyFileSync(cfg.PROCESSED_FILE, uniqueArchivePath(stamp, oldThreadId, 'processed'));
      fs.unlinkSync(cfg.PROCESSED_FILE);
    }
  } catch (e) {
    appendLog({ type: 'archive_warn', file: 'processed', error: e.message });
  }

  let keptCodes = [];
  try {
    const queue = getQueue();
    if (queue.length) {
      const catalog = getCodeCatalog();
      const cutoff = monthStartMs(now);
      const queuedMs = (c) => {
        const m = catalog.codes[c] || {};
        return Date.parse(m.queuedAt || m.lastSeenAt || m.updatedAt || '') || 0;
      };
      keptCodes = queue.filter(c => queuedMs(c) >= cutoff);
      const archived = queue.filter(c => queuedMs(c) < cutoff);
      if (archived.length) {
        fs.writeFileSync(uniqueArchivePath(stamp, oldThreadId, 'queue'), archived.join('\n') + '\n');
      }
      writeQueue(keptCodes);
    }
  } catch (e) {
    appendLog({ type: 'archive_warn', file: 'queue', error: e.message });
  }

  saveTriedState({ thread_id: newThreadId, tried_codes: [], successful_codes: [], failed_codes: [] });
  saveThreadId(newThreadId, newMonth);
  writeFileAtomic(cfg.THREAD_DETECTED_FILE, now.toISOString());
  invalidateArchiveCache();
  appendLog({ type: 'monthly_reset', old_thread: oldThreadId, new_thread: newThreadId, month: newMonth, kept_queued: keptCodes.length });
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

// Savings bucketed by LOCAL calendar month from row timestamps — the cycle a
// row was archived under doesn't matter. Rows without a timestamp are legacy
// imports with no dollar detail, so skipping them loses nothing.
function bucketRows(rows, buckets, ueBuckets) {
  for (const r of rows) {
    if (r.result !== 'success' || !r.ts) continue;
    const month = monthKey(r.ts);
    if (!month) continue;
    const saved = parseSavings(r.detail);
    buckets[month] = (buckets[month] || 0) + saved;
    if (/·\s*UberEats\b/i.test(r.detail || '')) ueBuckets[month] = (ueBuckets[month] || 0) + saved;
  }
}

// Archives only change at a monthly reset, so their rows and buckets are
// cached by the directory's file list.
let _archiveCache = null;
function invalidateArchiveCache() { _archiveCache = null; }

function archiveData() {
  let files = [];
  try { files = fs.readdirSync(cfg.ARCHIVE_DIR).filter(f => f.endsWith('-processed.txt') || /-processed-\d+\.txt$/.test(f)).sort(); }
  catch {}
  const key = files.join('|');
  if (_archiveCache && _archiveCache.key === key) return _archiveCache;
  const buckets = {};
  const ueBuckets = {};
  const rows = files.flatMap(f => readProcessedFile(path.join(cfg.ARCHIVE_DIR, f)));
  bucketRows(rows, buckets, ueBuckets);
  _archiveCache = { key, buckets, ueBuckets, rows };
  return _archiveCache;
}

function getSavingsSummary(now = new Date()) {
  const archived = archiveData();
  const buckets = { ...archived.buckets };
  const ueBuckets = { ...archived.ueBuckets };
  bucketRows(getProcessed(), buckets, ueBuckets);
  const currentMonth = monthKey(now);
  const lastMonth = previousMonthKey(currentMonth);
  if (!(currentMonth in buckets)) buckets[currentMonth] = 0;
  const months = Object.keys(buckets).sort();
  return {
    currentMonth,
    savedThisMonth: buckets[currentMonth],
    // null = no history before this month (nothing to compare against)
    savedLastMonth: months[0] < currentMonth ? (buckets[lastMonth] || 0) : null,
    savedLifetime: months.reduce((s, m) => s + buckets[m], 0),
    savedOnUberEats: ueBuckets[currentMonth] || 0,
    monthlySavings: months.map(month => ({ month, saved: buckets[month] })),
  };
}

function getMonthlySavings(now = new Date()) {
  return getSavingsSummary(now).monthlySavings;
}

// When the cycle last turned over — the newest archive filename's date.
function getLastResetDate() {
  try {
    const dates = fs.readdirSync(cfg.ARCHIVE_DIR)
      .map(f => (f.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1])
      .filter(Boolean)
      .sort();
    return dates.length ? dates[dates.length - 1] : null;
  } catch {
    return null;
  }
}

// ── Stats ────────────────────────────────────────────────────────────────────

// This calendar month's results, one per code, whether still in processed.txt
// or already archived by a monthly reset. A code that landed this month keeps
// that row even if a later re-check only said "Already applied".
function monthResults(now = new Date()) {
  const month = monthKey(now);
  const landed = (r) => r.result === 'region_skip' || (r.result === 'success' && !isAlreadyApplied(r));
  const rows = [...archiveData().rows, ...getProcessed()]
    .filter(r => r.ts && monthKey(r.ts) === month)
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const byCode = new Map();
  for (const r of rows) {
    const prev = byCode.get(r.code);
    if (prev && landed(prev) && !landed(r)) continue;
    byCode.set(r.code, r);
  }
  return [...byCode.values()].map(r => ({
    ...r,
    platform: platformOf(r),
    amount: isAlreadyApplied(r) ? null : amountOf(r.detail),
    location: r.result === 'region_skip' ? locationOf(r.detail) : null,
  }));
}

function getStats() {
  const month = monthResults();
  const queueCount = getQueue().length;
  const catalog = getCodeCatalog();

  const successes = month.filter(r => r.result === 'success');
  // "Already applied" successes confirm that a code from an earlier cycle is
  // still on the account — not fresh wins, so they don't count as "applied".
  const freshSuccesses = successes.filter(r => !isAlreadyApplied(r));
  const regionLocked = month.filter(r => r.result === 'region_skip');
  const u = getUSCFState();
  const recentCutoff = Date.now() - cfg.REAPPLY_SKIP_DAYS * 86400000;

  return {
    threadId: getThreadId(),
    threadMonth: getThreadMonth(),
    ueThreadId: getUEThreadId(),
    ueThreadMonth: getUEThreadMonth(),
    threadFreshness: getThreadFreshness(),
    uscf: {
      topicId: cfg.USCF_TOPIC_ID,
      url: `${cfg.USCF_BASE_URL}/t/topic/${cfg.USCF_TOPIC_ID}`,
      lastPostNumber: u.lastPostNumber || null,
      lastScanAt: u.lastScanAt || null,
    },
    // Codes inside the re-apply skip window — shown on the Queue page so
    // "why isn't X queued?" has a visible answer.
    recentlyAppliedList: Object.entries(loadAppliedLedger())
      .map(([code, ts]) => ({ code, appliedAt: ts, ms: new Date(ts).getTime() }))
      .filter(e => !isNaN(e.ms) && e.ms >= recentCutoff)
      .sort((a, b) => b.ms - a.ms)
      .map(({ code, appliedAt }) => ({ code, appliedAt })),
    reapplySkipDays: cfg.REAPPLY_SKIP_DAYS,
    queueCount,
    totalTried: month.length,
    successCount: freshSuccesses.length,
    alreadyOnAccountCount: successes.length - freshSuccesses.length,
    rejectedCount: month.filter(r => r.result === 'rejected').length,
    rateLimitedCount: month.filter(r => r.result === 'ratelimited').length,
    regionLockedCount: regionLocked.length,
    ...getSavingsSummary(),
    lastResetDate: getLastResetDate(),
    appVersion: require('../package.json').version,
    heartbeat: getHeartbeat(),
    successList: successes.map(r => ({ code: r.code, detail: r.detail, already: isAlreadyApplied(r), platform: r.platform, amount: r.amount })),
    regionLockedList: regionLocked.map(r => ({ code: r.code, detail: r.detail, platform: r.platform, amount: r.amount, location: r.location })),
    monitoredSources: Object.entries(catalog.sources)
      .map(([key, value]) => ({ key, ...value }))
      .sort((a, b) => (a.label || a.key).localeCompare(b.label || b.key)),
  };
}

module.exports = {
  ensureDirs,
  normalizeCode,
  getCodeCatalog, saveCodeCatalog, mergeCodeMeta, setSourceStatus,
  getQueue, addToQueue, removeFromQueue, rankQueue,
  getQueueDetails,
  getProcessed, markResult, reclassifyResult, requeueResult, deleteResult,
  getProcessedDetails, amountOf, locationOf,
  getTriedState, saveTriedState,
  getThreadId, getThreadMonth, saveThreadId,
  getThreadDetectedAt, getUEThreadDetectedAt,
  getThreadFreshness, computeThreadState,
  monthlyReset,
  getUEThreadId, getUEThreadMonth, saveUEThreadId,
  getUETriedState, saveUETriedState,
  ueMonthlyReset,
  appendLog, getLog,
  recordApplied, getRecentlyApplied, loadAppliedLedger,
  getUSCFState, saveUSCFState,
  getMonthlySavings, getSavingsSummary,
  setHealthWarning, getHealthWarning, clearHealthWarning,
  getHeartbeat, recordHeartbeat,
  parseSavings, sumSavings,
  getStats,
};
