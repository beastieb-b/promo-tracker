// Per-account state: the queue, results, "already applied" ledger, per-code
// flags (held for Uber Eats, failure counts, …), archives and savings of ONE
// account. Everything shared by all accounts — the code catalog, source
// status, monthly threads, logs — lives in state.js.
//
//   const s = store(account);  s.addToQueue([...]);  s.markResult(code, ...);

const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const state = require('./state');
const { writeFileAtomic } = require('./atomic');
const { monthKey, previousMonthKey, monthStartMs, dateKey } = require('./time');

const {
  normalizeCode, readText, readJson, parseProcessedLine, readProcessedFile,
  amountOf, locationOf, platformOf, isAlreadyApplied, parseSavings,
} = state;

// Per-account facts about a code (the catalog only holds where it came from).
const FLAG_KEYS = ['queuedAt', 'manual', 'pendingUberEats', 'ueOnly', 'pmDetail', 'transientFailures', 'confirmPending', 'appliedOn'];

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

const isArchivedResults = (f) => /-processed(-\d+)?\.txt$/.test(f);

// Archives only change at a monthly reset, so their rows and buckets are
// cached per archive directory by its file list.
const archiveCache = new Map();

function enrich(row) {
  return {
    ...row,
    platform: platformOf(row),
    amount: isAlreadyApplied(row) ? null : amountOf(row.detail),
    location: row.result === 'region_skip' ? locationOf(row.detail) : null,
  };
}

// A code's shared catalog entry, minus per-account keys an older version
// kept there (they belong to one account and must not leak into another's
// queue order or a retry).
function catalogMeta(catalog, code) {
  const meta = { ...(catalog.codes[code] || {}) };
  for (const k of FLAG_KEYS) delete meta[k];
  return meta;
}

// Is the code waiting in some OTHER account's queue right now?
function queuedElsewhere(accountId, code) {
  for (const other of require('./accounts').list()) {
    if (other.id === accountId) continue;
    const q = readText(other.paths.queue) || '';
    if (q.split('\n').some(l => l.trim() === code)) return true;
  }
  return false;
}

function store(account) {
  const p = account.paths;
  const tag = { account: account.id, accountName: account.name };

  // ── Flags ────────────────────────────────────────────────────────────────
  function allFlags() {
    let raw = null;
    try {
      raw = fs.readFileSync(p.flags, 'utf8');
    } catch (err) {
      // Anything but "not there yet" is a real problem: never fall back to
      // the old copy in the catalog and write it over newer flags.
      if (err.code !== 'ENOENT') throw err;
    }
    if (raw !== null) return JSON.parse(raw);
    // First use: the main account's flags used to live in the shared catalog.
    const flags = {};
    if (account.id === 'main') {
      for (const [code, meta] of Object.entries(state.getCodeCatalog().codes)) {
        const f = {};
        for (const k of FLAG_KEYS) if (meta && meta[k] !== undefined) f[k] = meta[k];
        if (Object.keys(f).length) flags[code] = f;
      }
    }
    return flags;
  }

  function saveFlags(flags) {
    fs.mkdirSync(path.dirname(p.flags), { recursive: true });
    writeFileAtomic(p.flags, JSON.stringify(flags, null, 2));
  }

  function getFlags(code) {
    return allFlags()[code] || {};
  }

  function setFlags(code, patch) {
    const normalized = normalizeCode(code);
    if (!normalized) return false;
    const flags = allFlags();
    flags[normalized] = { ...(flags[normalized] || {}), ...patch };
    saveFlags(flags);
    return true;
  }

  // ── Queue ────────────────────────────────────────────────────────────────
  function getQueue() {
    return (readText(p.queue) || '').split('\n').map(l => l.trim()).filter(Boolean);
  }

  function writeQueue(codes) {
    fs.mkdirSync(path.dirname(p.queue), { recursive: true });
    writeFileAtomic(p.queue, codes.join('\n') + (codes.length ? '\n' : ''));
  }

  function addToQueue(entries) {
    const existing = new Set(getQueue());
    const processed = new Set(getProcessed().map(r => r.code));
    const deduped = new Map();
    for (const raw of entries) {
      const entry = typeof raw === 'string' ? { code: raw } : raw;
      const code = normalizeCode(entry && entry.code);
      if (code) deduped.set(code, { ...entry, code });
    }
    const newEntries = [...deduped.values()].filter(e => !existing.has(e.code) && !processed.has(e.code));
    if (!newEntries.length) return 0;
    // A code new to this account updates the shared catalog — unless another
    // account is still waiting to try it: a second sighting (another thread,
    // the forum) must not overwrite the attribution and link it was queued with.
    const catalog = state.getCodeCatalog();
    const flags = allFlags();
    const now = new Date().toISOString();
    for (const entry of newEntries) {
      const meta = { ...entry };
      for (const k of FLAG_KEYS) delete meta[k];
      if (!catalog.codes[entry.code] || !queuedElsewhere(account.id, entry.code)) {
        catalog.codes[entry.code] = { ...(catalog.codes[entry.code] || {}), ...meta, code: entry.code, updatedAt: now };
      }
      flags[entry.code] = { ...(flags[entry.code] || {}), queuedAt: now, ...(entry.manual ? { manual: true } : {}) };
    }
    state.saveCodeCatalog(catalog);
    saveFlags(flags);
    fs.mkdirSync(path.dirname(p.queue), { recursive: true });
    fs.appendFileSync(p.queue, newEntries.map(e => e.code).join('\n') + '\n');
    return newEntries.length;
  }

  function removeFromQueue(code) {
    const normalized = normalizeCode(code);
    if (!normalized) return false;
    const queue = getQueue();
    if (!queue.includes(normalized)) return false;
    writeQueue(queue.filter(c => c !== normalized));
    return true;
  }

  function getQueueDetails() {
    const catalog = state.getCodeCatalog();
    const flags = allFlags();
    return rankQueue(getQueue().map(code => ({ ...catalogMeta(catalog, code), ...(flags[code] || {}), code })))
      .map(e => ({ ...e, ...tag }));
  }

  // ── Results ──────────────────────────────────────────────────────────────
  function getProcessed() {
    return readProcessedFile(p.processed);
  }

  function archiveData() {
    let files = [];
    try { files = fs.readdirSync(p.archive).filter(isArchivedResults).sort(); } catch {}
    const key = files.join('|');
    const cached = archiveCache.get(p.archive);
    if (cached && cached.key === key) return cached;
    const buckets = {};
    const ueBuckets = {};
    const rows = files.flatMap(f => readProcessedFile(path.join(p.archive, f)));
    bucketRows(rows, buckets, ueBuckets);
    const data = { key, buckets, ueBuckets, rows };
    archiveCache.set(p.archive, data);
    return data;
  }

  const invalidateArchive = () => archiveCache.delete(p.archive);

  // Results shown on the dashboard: this cycle's processed.txt plus anything a
  // monthly reset already archived from the current calendar month. Oldest first.
  function getProcessedDetails(now = new Date()) {
    const catalog = state.getCodeCatalog();
    const month = monthKey(now);
    const archived = archiveData().rows
      .filter(r => r.ts && monthKey(r.ts) === month)
      .map(r => ({ ...r, archived: true }));
    return [...archived, ...getProcessed()]
      .sort((a, b) => ((a.ts || '') < (b.ts || '') ? -1 : (a.ts || '') > (b.ts || '') ? 1 : 0))
      .map(item => ({ ...enrich({ ...catalogMeta(catalog, item.code), ...item }), ...tag }));
  }

  // Rewrite one code's result rows wherever the dashboard shows them:
  // processed.txt, plus this calendar month's rows in archive files.
  // fn(row) returns a replacement line, null to delete the row, or undefined
  // to keep it. Returns how many rows fn changed.
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
    editFile(p.processed, false);
    let archiveTouched = false;
    try {
      for (const f of fs.readdirSync(p.archive)) {
        if (isArchivedResults(f) && editFile(path.join(p.archive, f), true)) archiveTouched = true;
      }
    } catch {}
    if (archiveTouched) invalidateArchive();
    return changed;
  }

  function markResult(code, result, detail = null) {
    const normalized = normalizeCode(code);
    if (!normalized) return false;
    removeFromQueue(normalized);
    const safeDetail = detail ? String(detail).replace(/[\t\n\r]/g, ' ').slice(0, 120) : '';
    fs.mkdirSync(path.dirname(p.processed), { recursive: true });
    fs.appendFileSync(p.processed, `${normalized}\t${result}\t${safeDetail}\t${new Date().toISOString()}\n`);
    // Success AND region_skip both mean the code landed on the account —
    // record them so a scan won't re-queue the code while it's still there.
    if (result === 'success' || result === 'region_skip') recordApplied(normalized);
    // A hand-added code jumps the queue once; a settled code starts its
    // failure count over if it ever comes back.
    const f = getFlags(normalized);
    if (f.manual || f.transientFailures || f.confirmPending) {
      setFlags(normalized, { manual: false, transientFailures: 0, confirmPending: false });
    }
    return true;
  }

  // Forget a code for this account: its result rows, its ledger entry, and
  // the shared "seen in this month's thread" marks, so a scan can queue it again.
  function deleteResult(code) {
    const normalized = normalizeCode(code);
    if (!normalized) return false;
    const found = editResultRows(normalized, () => null) > 0;
    state.forgetSeen(normalized);
    forgetApplied(normalized);
    return found;
  }

  // Put a processed code back in the queue (the "Retry" action, and Uber Eats
  // retries after a login comes back).
  function requeueResult(code) {
    const normalized = normalizeCode(code);
    if (!normalized) return false;
    deleteResult(normalized);
    addToQueue([{ ...catalogMeta(state.getCodeCatalog(), normalized), code: normalized }]);
    return true;
  }

  // Correct a verdict in place (keeps its timestamp): flag a success as
  // region-locked (stops counting) or count one back. Only rows where the
  // code landed flip; the detail is rebuilt from the amount.
  function reclassifyResult(code, newResult) {
    const normalized = normalizeCode(code);
    if (!normalized || !['success', 'region_skip'].includes(newResult)) return false;
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
    state.mergeCodeMeta(normalized, { regionRestricted: newResult === 'region_skip' });
    return true;
  }

  // ── Applied ledger ───────────────────────────────────────────────────────
  // Codes that landed on this account, with when. Scans skip re-queueing a
  // code applied within REAPPLY_SKIP_DAYS (re-trying only gets "you already
  // applied this promotion"); past the window it's eligible again.
  function loadAppliedLedger() {
    return readJson(p.ledger, {});
  }

  function saveAppliedLedger(ledger) {
    fs.mkdirSync(path.dirname(p.ledger), { recursive: true });
    writeFileAtomic(p.ledger, JSON.stringify(ledger, null, 2));
  }

  function recordApplied(code, ts = new Date().toISOString()) {
    const ledger = loadAppliedLedger();
    ledger[code] = ts;
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

  // Codes applied within the last `days`. `ledger` is injectable for tests.
  function getRecentlyApplied(days = cfg.REAPPLY_SKIP_DAYS, ledger = loadAppliedLedger(), now = Date.now()) {
    const cutoff = now - days * 86400000;
    const out = new Set();
    for (const [code, ts] of Object.entries(ledger)) {
      const ms = new Date(ts).getTime();
      if (!isNaN(ms) && ms >= cutoff) out.add(code);
    }
    return out;
  }

  // ── Monthly archive ──────────────────────────────────────────────────────
  // At a new r/postmates monthly thread: archive this cycle's results and the
  // codes queued before the current calendar month (last month's codes have
  // mostly expired). Codes queued this month stay. Returns how many stayed.
  function uniqueArchivePath(stamp, threadId, suffix) {
    const base = `${stamp}-${threadId || 'unknown'}-${suffix}`;
    let dest = path.join(p.archive, `${base}.txt`);
    for (let n = 2; fs.existsSync(dest); n++) dest = path.join(p.archive, `${base}-${n}.txt`);
    return dest;
  }

  function monthlyArchive(oldThreadId, now = new Date()) {
    const stamp = dateKey(now);
    fs.mkdirSync(p.archive, { recursive: true });
    try {
      if (fs.existsSync(p.processed)) {
        fs.copyFileSync(p.processed, uniqueArchivePath(stamp, oldThreadId, 'processed'));
        fs.unlinkSync(p.processed);
      }
    } catch (e) {
      state.appendLog({ type: 'archive_warn', account: account.id, file: 'processed', error: e.message });
    }
    let kept = [];
    try {
      const queue = getQueue();
      if (queue.length) {
        const catalog = state.getCodeCatalog();
        const flags = allFlags();
        const cutoff = monthStartMs(now);
        const queuedMs = (c) => {
          const m = { ...catalogMeta(catalog, c), ...(flags[c] || {}) };
          return Date.parse(m.queuedAt || m.lastSeenAt || m.updatedAt || '') || 0;
        };
        kept = queue.filter(c => queuedMs(c) >= cutoff);
        const archived = queue.filter(c => queuedMs(c) < cutoff);
        if (archived.length) fs.writeFileSync(uniqueArchivePath(stamp, oldThreadId, 'queue'), archived.join('\n') + '\n');
        writeQueue(kept);
      }
    } catch (e) {
      state.appendLog({ type: 'archive_warn', account: account.id, file: 'queue', error: e.message });
    }
    invalidateArchive();
    return kept.length;
  }

  // ── Month view & savings ─────────────────────────────────────────────────
  // This calendar month's results, one per code, whether still in
  // processed.txt or already archived. A code that landed this month keeps
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
    return [...byCode.values()].map(r => ({ ...enrich(r), ...tag }));
  }

  // Savings by local calendar month: { buckets, ueBuckets } (month → $).
  function savingsBuckets() {
    const archived = archiveData();
    const buckets = { ...archived.buckets };
    const ueBuckets = { ...archived.ueBuckets };
    bucketRows(getProcessed(), buckets, ueBuckets);
    return { buckets, ueBuckets };
  }

  function getSavingsSummary(now = new Date()) {
    return summarizeSavings([savingsBuckets()], now);
  }

  function getLastResetDate() {
    try {
      const dates = fs.readdirSync(p.archive)
        .map(f => (f.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1])
        .filter(Boolean)
        .sort();
      return dates.length ? dates[dates.length - 1] : null;
    } catch {
      return null;
    }
  }

  return {
    account,
    getFlags, setFlags, allFlags,
    getQueue, addToQueue, removeFromQueue, getQueueDetails,
    getProcessed, getProcessedDetails, markResult, deleteResult, requeueResult, reclassifyResult,
    loadAppliedLedger, recordApplied, getRecentlyApplied,
    monthlyArchive, monthResults, savingsBuckets, getSavingsSummary, getLastResetDate,
  };
}

// Combine savings buckets (one per account) into the dashboard's summary.
function summarizeSavings(parts, now = new Date()) {
  const buckets = {};
  const ueBuckets = {};
  for (const part of parts) {
    for (const [m, v] of Object.entries(part.buckets)) buckets[m] = (buckets[m] || 0) + v;
    for (const [m, v] of Object.entries(part.ueBuckets)) ueBuckets[m] = (ueBuckets[m] || 0) + v;
  }
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

function forAccount(id) {
  const account = require('./accounts').get(id);
  return account ? store(account) : null;
}

const main = () => store(require('./accounts').main());
const active = () => require('./accounts').active().map(store);

module.exports = { store, forAccount, main, active, rankQueue, summarizeSavings, catalogMeta, FLAG_KEYS };
