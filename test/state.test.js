const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const dir = require('./helpers').useTempData();
const cfg = require('../src/config');
const state = require('../src/state');
const { monthKey } = require('../src/time');

function reset() {
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  state.ensureDirs();
}

test('normalizes safe promo codes', () => {
  assert.strictEqual(state.normalizeCode(' save20 '), 'SAVE20');
  assert.strictEqual(state.normalizeCode('ABC_123-XYZ'), 'ABC_123-XYZ');
});

test('rejects unsafe or line-based promo code input', () => {
  assert.strictEqual(state.normalizeCode('A\nB'), null);
  assert.strictEqual(state.normalizeCode('<IMG SRC=x>'), null);
  assert.strictEqual(state.normalizeCode('abc'), null);
  assert.strictEqual(state.normalizeCode('A'.repeat(33)), null);
});

test('getRecentlyApplied: only codes inside the window', () => {
  const now = Date.parse('2026-07-03T12:00:00Z');
  const day = 86400000;
  const ledger = {
    FRESH: new Date(now - 2 * day).toISOString(),
    EDGE: new Date(now - 13.9 * day).toISOString(),
    OLD: new Date(now - 15 * day).toISOString(),
    BROKEN: 'not-a-date',
  };
  const recent = state.getRecentlyApplied(cfg.REAPPLY_SKIP_DAYS, ledger, now);
  assert.ok(recent.has('FRESH'));
  assert.ok(recent.has('EDGE'));
  assert.ok(!recent.has('OLD'));
  assert.ok(!recent.has('BROKEN'));
});

test('computeThreadState: found / waiting / stale / unknown', () => {
  const G = cfg.STALE_THREAD_GRACE_DAYS;
  assert.strictEqual(state.computeThreadState('2026-07', '2026-07', 1), 'found');
  assert.strictEqual(state.computeThreadState('2026-08', '2026-07', 30), 'found'); // next month's thread posted early
  assert.strictEqual(state.computeThreadState('2026-06', '2026-07', 1), 'waiting');
  assert.strictEqual(state.computeThreadState('2026-06', '2026-07', G - 1), 'waiting');
  assert.strictEqual(state.computeThreadState('2026-06', '2026-07', G), 'stale');
  assert.strictEqual(state.computeThreadState(null, '2026-07', 5), 'unknown');
});

test('queue: hand-added codes first, then codes with digits, then confidence', () => {
  reset();
  state.addToQueue([
    { code: 'WORDYCODE', confidenceScore: 90 },
    { code: 'SAVE20', confidenceScore: 60 },
    { code: 'TACO10', confidenceScore: 80 },
  ]);
  state.addToQueue([{ code: 'BURGERNOW', manual: true }]);
  assert.deepStrictEqual(state.getQueueDetails().map(e => [e.code, e.priority]),
    [['BURGERNOW', 1], ['TACO10', 2], ['SAVE20', 3], ['WORDYCODE', 4]]);
  state.markResult('BURGERNOW', 'rejected', 'Code not valid');
  assert.strictEqual(state.getCodeCatalog().codes.BURGERNOW.manual, false);
});

test('deleteResult forgets the code everywhere, including the applied ledger', () => {
  reset();
  state.addToQueue(['WIN2026']);
  state.markResult('WIN2026', 'success', '$10 off');
  assert.ok(state.getRecentlyApplied().has('WIN2026'));
  assert.strictEqual(state.deleteResult('WIN2026'), true);
  assert.ok(!state.getRecentlyApplied().has('WIN2026'));
  assert.deepStrictEqual(state.getProcessed(), []);
  assert.strictEqual(state.deleteResult('WIN2026'), false);
});

test('reclassify rebuilds the detail from the amount and keeps the platform', () => {
  reset();
  state.addToQueue(['UE15']);
  state.markResult('UE15', 'success', '$15 off · UberEats');
  state.reclassifyResult('UE15', 'region_skip');
  let row = state.getProcessedDetails()[0];
  assert.strictEqual(row.result, 'region_skip');
  assert.strictEqual(row.detail, '$15 off — region-locked · UberEats');
  assert.strictEqual(row.platform, 'ubereats');
  state.reclassifyResult('UE15', 'success');
  row = state.getProcessedDetails()[0];
  assert.strictEqual(row.detail, '$15 off · UberEats');
  assert.strictEqual(row.amount, '$15');
});

test('monthly reset: archives results, keeps codes queued this month, never overwrites an archive', () => {
  reset();
  const now = new Date(2026, 9, 2, 9, 0); // Oct 2, local
  state.addToQueue(['OLDSEP1', 'NEWOCT1']);
  const catalog = state.getCodeCatalog();
  catalog.codes.OLDSEP1.queuedAt = new Date(2026, 8, 29).toISOString();
  catalog.codes.NEWOCT1.queuedAt = new Date(2026, 9, 1, 8).toISOString();
  state.saveCodeCatalog(catalog);
  fs.writeFileSync(cfg.PROCESSED_FILE, 'SEPWIN\tsuccess\t$20 off\t2026-09-20T18:00:00.000Z\n');

  state.monthlyReset('aaa111', 'bbb222', '2026-10', now);
  assert.deepStrictEqual(state.getQueue(), ['NEWOCT1']);
  assert.deepStrictEqual(state.getProcessed(), []);
  assert.strictEqual(state.getThreadId(), 'bbb222');

  // A second reset the same day from the same old thread must not clobber
  // the first archive.
  fs.writeFileSync(cfg.PROCESSED_FILE, 'X1234\trejected\tCode not valid\t2026-10-02T10:00:00.000Z\n');
  state.monthlyReset('aaa111', 'ccc333', '2026-10', now);
  const files = fs.readdirSync(cfg.ARCHIVE_DIR).sort();
  assert.deepStrictEqual(files, ['2026-10-02-aaa111-processed-2.txt', '2026-10-02-aaa111-processed.txt', '2026-10-02-aaa111-queue.txt']);
});

test('savings follow the calendar month of each win, wherever it is archived', () => {
  reset();
  const now = new Date();
  const thisMonth = monthKey(now);
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 15, 12);
  const archived = [
    `A1\tsuccess\t$20 off\t${lastMonthDate.toISOString()}`,
    `A2\tsuccess\t$5 off · UberEats\t${new Date(now.getFullYear(), now.getMonth(), 1, 12).toISOString()}`,
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(cfg.ARCHIVE_DIR, '2026-01-01-xyz-processed.txt'), archived);
  fs.writeFileSync(cfg.PROCESSED_FILE, `B1\tsuccess\t$10 off\t${now.toISOString()}\nB2\tsuccess\tAlready applied\t${now.toISOString()}\nB3\tregion_skip\t$50 off — Las Vegas only\t${now.toISOString()}\n`);
  const s = state.getSavingsSummary(now);
  assert.strictEqual(s.currentMonth, thisMonth);
  assert.strictEqual(s.savedThisMonth, 15);
  assert.strictEqual(s.savedOnUberEats, 5);
  assert.strictEqual(s.savedLastMonth, 20);
  assert.strictEqual(s.savedLifetime, 35);
  assert.deepStrictEqual(s.monthlySavings.map(m => m.month), [monthKey(lastMonthDate), thisMonth]);
});

test('savedLastMonth is null when there is no earlier history', () => {
  reset();
  assert.strictEqual(state.getSavingsSummary().savedLastMonth, null);
});

test('stats rows carry platform, amount and location', () => {
  reset();
  state.addToQueue(['LV10', 'UE20', 'OLD1']);
  state.markResult('LV10', 'region_skip', '$10 off — Las Vegas only');
  state.markResult('UE20', 'success', '$20 off · UberEats');
  state.markResult('OLD1', 'success', 'Already applied');
  const st = state.getStats();
  assert.deepStrictEqual(st.regionLockedList[0], { code: 'LV10', detail: '$10 off — Las Vegas only', platform: 'postmates', amount: '$10', location: 'Las Vegas' });
  assert.strictEqual(st.successList.find(r => r.code === 'UE20').platform, 'ubereats');
  assert.strictEqual(st.successList.find(r => r.code === 'OLD1').already, true);
  assert.strictEqual(st.successCount, 1);
  assert.strictEqual(st.alreadyOnAccountCount, 1);
});

test('stats count this calendar month, across a monthly reset, one row per code', () => {
  reset();
  const now = new Date();
  const earlier = new Date(now.getFullYear(), now.getMonth(), 1, 9).toISOString();
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 20).toISOString();
  fs.writeFileSync(path.join(cfg.ARCHIVE_DIR, '2026-01-01-old-processed.txt'), [
    `WON1\tsuccess\t$15 off\t${earlier}`,
    `GONE1\trejected\tCode not valid\t${earlier}`,
    `LASTMO\tsuccess\t$20 off\t${prevMonth}`,
  ].join('\n') + '\n');
  fs.writeFileSync(cfg.PROCESSED_FILE, `WON1\tsuccess\tAlready applied\t${now.toISOString()}\nNEW2\tsuccess\t$5 off · UberEats\t${now.toISOString()}\n`);
  const st = state.getStats();
  assert.strictEqual(st.totalTried, 3);                       // WON1, GONE1, NEW2 (not last month's)
  assert.strictEqual(st.successCount, 2);                     // WON1 keeps its $15 win, NEW2
  assert.strictEqual(st.alreadyOnAccountCount, 0);
  assert.strictEqual(st.rejectedCount, 1);
  assert.deepStrictEqual(st.successList.map(r => [r.code, r.amount, r.platform]).sort(),
    [['NEW2', '$5', 'ubereats'], ['WON1', '$15', 'postmates']]);
  assert.strictEqual(st.savedThisMonth, 20);
});

test('results archived earlier this month stay visible and can be corrected or deleted', () => {
  reset();
  const now = new Date();
  const early = new Date(now.getFullYear(), now.getMonth(), 1, 8).toISOString();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 20).toISOString();
  const archive = path.join(cfg.ARCHIVE_DIR, '2026-01-02-abc-processed.txt');
  fs.writeFileSync(archive, `EARLY1\tsuccess\t$15 off\t${early}\nEARLY1\tsuccess\t$9 off\t${lastMonth}\nGONE2\trejected\tCode not valid\t${early}\n`);
  fs.writeFileSync(cfg.PROCESSED_FILE, `NOW3\tsuccess\t$5 off\t${now.toISOString()}\n`);

  assert.deepStrictEqual(state.getProcessedDetails().map(r => [r.code, !!r.archived]), [['EARLY1', true], ['GONE2', true], ['NOW3', false]]);
  assert.strictEqual(state.reclassifyResult('EARLY1', 'region_skip'), true);
  assert.strictEqual(state.getStats().savedThisMonth, 5, 'the region-locked early win no longer counts');
  assert.match(fs.readFileSync(archive, 'utf8'), /EARLY1\tsuccess\t\$9 off/, 'last month\'s row is untouched');
  assert.strictEqual(state.reclassifyResult('GONE2', 'success'), false, 'a rejection is not a win to recount');
  assert.strictEqual(state.deleteResult('GONE2'), true);
  assert.deepStrictEqual(state.getProcessedDetails().map(r => r.code), ['EARLY1', 'NOW3']);
});
