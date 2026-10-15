// Multiple accounts: registry, per-account state, scanning and apply runs.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, beforeEach } = require('node:test');
const dir = require('./helpers').useTempData();
const cfg = require('../src/config');
const state = require('../src/state');
const settings = require('../src/settings');
const accounts = require('../src/accounts');
const stores = require('../src/store');
const { queueForAccounts } = require('../src/reddit');
const { runApplyCodes } = require('../src/runner');

beforeEach(() => {
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  state.ensureDirs();
});

const enable = () => settings.save({ multiAccount: true });

test('off by default: only the first account, at the original file locations', () => {
  assert.strictEqual(accounts.enabled(), false);
  assert.deepStrictEqual(accounts.active().map(a => a.id), ['main']);
  assert.strictEqual(accounts.main().paths.queue, cfg.QUEUE_FILE);
  assert.strictEqual(accounts.main().paths.profile, cfg.BROWSER_PROFILE_DIR);
});

test('accounts can be added, renamed and removed (moved aside); the first can\'t be removed', () => {
  enable();
  const b = accounts.create('Partner');
  assert.match(b.id, /^[a-f0-9]{6}$/);
  assert.ok(fs.existsSync(b.paths.profile));
  assert.deepStrictEqual(accounts.active().map(a => a.name), ['Account 1', 'Partner']);
  assert.strictEqual(accounts.rename(b.id, '  Sam ').name, 'Sam');
  assert.throws(() => accounts.create(''), /1–30/);
  assert.throws(() => accounts.remove('main'), /can't be removed/);
  accounts.remove(b.id);
  assert.deepStrictEqual(accounts.list().map(a => a.id), ['main']);
  assert.strictEqual(fs.readdirSync(path.join(dir, 'accounts-removed')).length, 1);
  // Turning the setting off hides other accounts without deleting them.
  const c = accounts.create('Guest');
  settings.save({ multiAccount: false });
  assert.deepStrictEqual(accounts.active().map(a => a.id), ['main']);
  assert.ok(accounts.get(c.id));
});

test('each account keeps its own queue, results, flags and applied list', () => {
  enable();
  const a = stores.main();
  const b = stores.store(accounts.create('Partner'));
  a.addToQueue(['SAVE20']);
  b.addToQueue(['SAVE20', 'TACO10']);
  a.markResult('SAVE20', 'success', '$20 off');
  b.setFlags('TACO10', { pendingUberEats: true });
  assert.deepStrictEqual(a.getQueue(), []);
  assert.deepStrictEqual(b.getQueue(), ['SAVE20', 'TACO10']);
  assert.ok(a.getRecentlyApplied().has('SAVE20'));
  assert.ok(!b.getRecentlyApplied().has('SAVE20'));
  assert.strictEqual(a.getFlags('TACO10').pendingUberEats, undefined);
  assert.deepStrictEqual(b.getQueueDetails().map(e => [e.code, e.account, e.accountName]), [['SAVE20', b.account.id, 'Partner'], ['TACO10', b.account.id, 'Partner']]);
});

test('the first account\'s per-code flags are carried over from the old shared catalog', () => {
  state.saveCodeCatalog({ codes: { OLD1: { code: 'OLD1', sourceKey: 'uscf', pendingUberEats: true, pmDetail: 'Code not valid' } }, sources: {} });
  assert.deepStrictEqual(stores.main().getFlags('OLD1'), { pendingUberEats: true, pmDetail: 'Code not valid' });
});

test('scans queue new codes for every account, skipping per account what it applied recently', () => {
  enable();
  const a = stores.main();
  const b = stores.store(accounts.create('Partner'));
  a.recordApplied('WON1');
  a.recordApplied('BOTH1');
  b.recordApplied('BOTH1');
  const r = queueForAccounts([{ code: 'NEW1' }, { code: 'WON1' }, { code: 'BOTH1' }]);
  assert.strictEqual(r.queued, 2);                         // NEW1, WON1 (for B)
  assert.deepStrictEqual([...r.skippedEverywhere], ['BOTH1']);
  assert.deepStrictEqual(a.getQueue(), ['NEW1']);
  assert.deepStrictEqual(b.getQueue().sort(), ['NEW1', 'WON1']);
});

test('a monthly reset archives every account', () => {
  enable();
  const b = stores.store(accounts.create('Partner'));
  fs.writeFileSync(cfg.PROCESSED_FILE, 'A1234\tsuccess\t$5 off\t2026-09-20T18:00:00.000Z\n');
  fs.mkdirSync(path.dirname(b.account.paths.processed), { recursive: true });
  fs.writeFileSync(b.account.paths.processed, 'B1234\tsuccess\t$7 off\t2026-09-21T18:00:00.000Z\n');
  state.monthlyReset('old111', 'new222', '2026-10', new Date(2026, 9, 2));
  assert.deepStrictEqual(stores.main().getProcessed(), []);
  assert.deepStrictEqual(b.getProcessed(), []);
  assert.strictEqual(fs.readdirSync(b.account.paths.archive).length, 1);
});

test('an apply run goes account by account, each in its own Chrome profile', async () => {
  enable();
  const a = stores.main();
  const b = stores.store(accounts.create('Partner'));
  a.addToQueue(['AAA1']);
  b.addToQueue(['AAA1', 'BBB2']);
  const pages = [];
  const sleeps = [];
  const progress = [];
  const r = await runApplyCodes({
    onProgress: (u) => progress.push(u),
    deps: {
      getPage: async (profile) => { pages.push(profile); return { profile }; },
      closePage: async () => {},
      screenshot: async () => {},
      sleep: async (ms) => { sleeps.push(ms); },
      applyCode: async (page, code, platform, opts) => {
        if (opts.accountId === 'main') return { result: 'success', detail: '$5 off' };
        return code === 'AAA1' ? { result: 'not_logged_in', detail: 'expired' } : { result: 'success', detail: 'x' };
      },
    },
  });
  assert.deepStrictEqual(pages, [a.account.paths.profile, b.account.paths.profile]);
  assert.deepStrictEqual(r.results.map(x => [x.account, x.code, x.result]), [['main', 'AAA1', 'success'], [b.account.id, 'AAA1', 'not_logged_in']]);
  assert.deepStrictEqual(sleeps, [120000], 'the 2-minute gap also holds between accounts');
  assert.deepStrictEqual(b.getQueue().sort(), ['AAA1', 'BBB2'], 'a logged-out account keeps its codes');
  assert.ok(progress.every(u => u.account && u.account.id));
});

test('a rate limit on one account ends the whole run', async () => {
  enable();
  const b = stores.store(accounts.create('Partner'));
  stores.main().addToQueue(['AAA1']);
  b.addToQueue(['AAA1']);
  const calls = [];
  const r = await runApplyCodes({
    deps: {
      getPage: async () => ({}), closePage: async () => {}, screenshot: async () => {}, sleep: async () => {},
      applyCode: async (page, code, platform, opts) => { calls.push(opts.accountId); return { result: 'ratelimited', detail: 'Rate limit detected' }; },
    },
  });
  assert.strictEqual(r.rateLimited, true);
  assert.deepStrictEqual(calls, ['main']);
});

test('a code found expired on one account is settled for the others too', async () => {
  enable();
  const b = stores.store(accounts.create('Partner'));
  stores.main().addToQueue(['OLD123']);
  b.addToQueue(['OLD123']);
  const calls = [];
  await runApplyCodes({
    deps: {
      getPage: async () => ({}), closePage: async () => {}, screenshot: async () => {}, sleep: async () => {},
      applyCode: async (page, code, platform, opts) => { calls.push(opts.accountId); return { result: 'rejected', detail: 'Code expired' }; },
    },
  });
  assert.deepStrictEqual(calls, ['main'], 'the second account never spends an attempt on it');
  assert.deepStrictEqual(b.getQueue(), []);
  assert.strictEqual(b.getProcessed()[0].detail, 'Code expired (seen on Account 1)');
});

test('review fixes: flag migration only when the file is missing; old catalog flags never leak', () => {
  // Pre-upgrade catalog with main's old per-code notes in it.
  state.saveCodeCatalog({ codes: {
    WORDY: { code: 'WORDY', manual: true, pendingUberEats: true },
    ZZZ999: { code: 'ZZZ999' },
  }, sources: {} });
  const a = stores.main();
  a.setFlags('WORDY', { pendingUberEats: false, manual: false }); // the new world
  // An unreadable flags file must not silently resurrect the catalog's old copy.
  const flagsPath = a.account.paths.flags;
  fs.rmSync(flagsPath);
  fs.mkdirSync(flagsPath);
  assert.throws(() => a.getFlags('WORDY'));
  fs.rmSync(flagsPath, { recursive: true });
  a.setFlags('WORDY', { manual: false });

  // A second account must not inherit main's old "manual" from the catalog.
  enable();
  const b = stores.store(accounts.create('Partner'));
  b.addToQueue([{ code: 'WORDY' }, { code: 'ZZZ999' }]);
  assert.deepStrictEqual(b.getQueueDetails().map(e => e.code), ['ZZZ999', 'WORDY']);
  // Retry of an old hand-added code doesn't make it jump the queue again.
  a.addToQueue(['WORDY']);
  a.markResult('WORDY', 'rejected', 'Code not valid');
  a.requeueResult('WORDY');
  assert.notStrictEqual(a.getFlags('WORDY').manual, true);
});
