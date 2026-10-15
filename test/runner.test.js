// The apply run's state machine, with the browser replaced by a script of
// per-site verdicts.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, beforeEach } = require('node:test');
const dir = require('./helpers').useTempData();
const state = require('../src/state');
const S = () => require('../src/store').main();
const browser = require('../src/browser');
const { runApplyCodes } = require('../src/runner');

beforeEach(() => {
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  state.ensureDirs();
});

// script: { 'CODE@postmates': verdict | [verdicts...], 'CODE@ubereats': ... }
function harness(script, extra = {}) {
  const calls = [];
  const sleeps = [];
  const progress = [];
  const deps = {
    getPage: async () => ({}),
    closePage: async () => {},
    screenshot: async () => {},
    sleep: async (ms) => { sleeps.push(ms); },
    applyCode: async (page, code, platform, opts) => {
      calls.push(`${code}@${platform}`);
      let v = script[`${code}@${platform}`];
      if (Array.isArray(v)) v = v.shift();
      if (typeof v === 'function') v = v(opts);
      if (!v) throw new Error(`unscripted ${code}@${platform}`);
      return v;
    },
    ...extra,
  };
  return { calls, sleeps, progress, run: (o = {}) => runApplyCodes({ deps, onProgress: (u) => progress.push(u), ...o }) };
}

const rows = () => Object.fromEntries(S().getProcessed().map(r => [r.code, `${r.result}: ${r.detail}`]));

test('success, Uber Eats fallback, and "Code expired" (no fallback)', async () => {
  S().addToQueue(['AAA1', 'BBB2', 'CCC3']);
  const h = harness({
    'AAA1@postmates': { result: 'success', detail: '$10 off' },
    'BBB2@postmates': { result: 'rejected', detail: 'Code not valid' },
    'BBB2@ubereats': { result: 'success', detail: '$5 off' },
    'CCC3@postmates': { result: 'rejected', detail: 'Code expired' },
  });
  const r = await h.run();
  assert.strictEqual(r.applied, 3);
  assert.deepStrictEqual(h.calls, ['AAA1@postmates', 'BBB2@postmates', 'BBB2@ubereats', 'CCC3@postmates']);
  assert.deepStrictEqual(rows(), {
    AAA1: 'success: $10 off',
    BBB2: 'success: $5 off · UberEats',
    CCC3: 'rejected: Code expired',
  });
  assert.deepStrictEqual(S().getQueue(), []);
  assert.strictEqual(S().getFlags('BBB2').appliedOn, 'ubereats');
  assert.deepStrictEqual(h.sleeps, [120000, 120000]); // between codes, not after the last
  assert.ok(!browser.isBusy(), 'lease released');
});

test('a rate limit stops the run and keeps the rest queued', async () => {
  S().addToQueue(['AAA1', 'BBB2']);
  const h = harness({ 'AAA1@postmates': { result: 'ratelimited', detail: 'Rate limit detected' } });
  const r = await h.run();
  assert.strictEqual(r.rateLimited, true);
  assert.deepStrictEqual(S().getQueue().sort(), ['AAA1', 'BBB2']);
  assert.deepStrictEqual(rows(), {});
});

test('Postmates logged out stops the run; codes stay queued', async () => {
  S().addToQueue(['AAA1', 'BBB2']);
  const h = harness({ 'AAA1@postmates': { result: 'not_logged_in', detail: 'session expired' } });
  await h.run();
  assert.deepStrictEqual(h.calls, ['AAA1@postmates']);
  assert.strictEqual(S().getQueue().length, 2);
  assert.ok(h.progress.some(p => p.status === 'login_required'));
});

test('transient errors stay queued, with a cooldown before the next code', async () => {
  S().addToQueue(['AAA1', 'BBB2']);
  const h = harness({
    'AAA1@postmates': { result: 'error', detail: 'Promo modal did not open' },
    'BBB2@postmates': { result: 'success', detail: 'Applied!' },
  });
  await h.run();
  assert.deepStrictEqual(S().getQueue(), ['AAA1']);
  assert.deepStrictEqual(h.sleeps, [20000]);
});

test('Uber Eats logged out: the code is held for Uber Eats, later rejects are parked without trying', async () => {
  S().addToQueue(['AAA1', 'BBB2']);
  const h = harness({
    'AAA1@postmates': { result: 'rejected', detail: 'Code not valid' },
    'AAA1@ubereats': { result: 'not_logged_in', detail: 'Uber Eats session expired' },
    'BBB2@postmates': { result: 'rejected', detail: 'Not eligible for your account' },
  });
  await h.run();
  assert.deepStrictEqual(h.calls, ['AAA1@postmates', 'AAA1@ubereats', 'BBB2@postmates']);
  assert.deepStrictEqual(rows(), {
    AAA1: 'rejected: Code not valid · UberEats: retry after login',
    BBB2: 'rejected: Not eligible for your account · UberEats: retry after login',
  });
  assert.strictEqual(S().getFlags('AAA1').pendingUberEats, true);
  assert.strictEqual(S().getFlags('BBB2').pendingUberEats, true);

  // Once Uber Eats works again the parked codes come back flagged ueOnly and
  // go straight to Uber Eats.
  require('../src/login').requeuePendingUberEats(S());
  assert.deepStrictEqual(S().getQueue().sort(), ['AAA1', 'BBB2']);
  const h2 = harness({
    'AAA1@ubereats': { result: 'success', detail: '$7 off' },
    'BBB2@ubereats': { result: 'rejected', detail: 'Code not valid' },
  });
  await h2.run();
  assert.deepStrictEqual(h2.calls.sort(), ['AAA1@ubereats', 'BBB2@ubereats']);
  assert.strictEqual(rows().AAA1, 'success: $7 off · UberEats');
});

test('an Uber Eats error gets one retry', async () => {
  S().addToQueue(['AAA1']);
  const h = harness({
    'AAA1@postmates': { result: 'rejected', detail: 'Code not valid' },
    'AAA1@ubereats': [{ result: 'error', detail: 'modal closed' }, { result: 'rejected', detail: 'Code not valid' }],
  });
  await h.run();
  assert.deepStrictEqual(h.calls, ['AAA1@postmates', 'AAA1@ubereats', 'AAA1@ubereats']);
  assert.strictEqual(rows().AAA1, 'rejected: Code not valid · also on UberEats');
});

test('a confirmation pass is reported as progress', async () => {
  S().addToQueue(['AAA1']);
  const h = harness({
    'AAA1@postmates': (opts) => { opts.onConfirm(); return { result: 'success', detail: 'Applied!' }; },
  });
  await h.run();
  assert.ok(h.progress.some(p => p.code === 'AAA1' && p.status === 'confirming'));
});

test('never starts a code that might not finish inside the run budget', async () => {
  S().addToQueue(['AAA1', 'BBB2']);
  let t = 0;
  const h = harness({ 'AAA1@postmates': () => { t += 50 * 60000; return { result: 'success', detail: 'Applied!' }; } },
    { now: () => t, budgetMs: 60 * 60000, worstCaseMs: 12 * 60000 });
  const r = await h.run();
  assert.strictEqual(r.stoppedForTime, true);
  assert.deepStrictEqual(S().getQueue(), ['BBB2']);
});

test('refuses to run while something else holds the browser', async () => {
  S().addToQueue(['AAA1']);
  const release = browser.acquire('login');
  try {
    const r = await harness({}).run();
    assert.strictEqual(r.busy, true);
    assert.deepStrictEqual(S().getQueue(), ['AAA1']);
  } finally {
    release();
  }
});

test('an attempt that blows its deadline is an error and the page is replaced', async () => {
  S().addToQueue(['AAA1']);
  let pages = 0;
  const h = harness({ 'AAA1@postmates': () => new Promise(() => {}) },
    { attemptMs: 20, getPage: async () => ({ n: ++pages }) });
  await h.run();
  assert.strictEqual(pages, 2);
  assert.deepStrictEqual(S().getQueue(), ['AAA1']);
});

test('a code that fails 3 runs in a row is settled as rejected and gets its Uber Eats try', async () => {
  S().addToQueue(['STUCK1']);
  const siteError = { result: 'error', detail: 'Site error ("There was an error processing your request")', codeSpecific: true };
  for (let run = 1; run <= 2; run++) {
    await harness({ 'STUCK1@postmates': siteError }).run();
    assert.deepStrictEqual(S().getQueue(), ['STUCK1'], `still queued after run ${run}`);
    assert.strictEqual(S().getFlags('STUCK1').transientFailures, run);
  }
  const h = harness({
    'STUCK1@postmates': siteError,
    'STUCK1@ubereats': { result: 'rejected', detail: 'Code not valid' },
  });
  await h.run();
  assert.deepStrictEqual(h.calls, ['STUCK1@postmates', 'STUCK1@ubereats']);
  assert.deepStrictEqual(S().getQueue(), []);
  assert.strictEqual(rows().STUCK1, 'rejected: Failed 3 runs: site error · UberEats: Code not valid');
  assert.strictEqual(S().getFlags('STUCK1').transientFailures, 0);
});

test('our own trouble (box did not open) never counts toward giving up', async () => {
  S().addToQueue(['AAA1']);
  for (let run = 0; run < 4; run++) await harness({ 'AAA1@postmates': { result: 'error', detail: 'Promo modal did not open' } }).run();
  assert.deepStrictEqual(S().getQueue(), ['AAA1']);
  assert.ok(!S().getFlags('AAA1').transientFailures);
});

test('a win whose confirmation pass didn\'t finish is not mislabeled "Already applied" later', async () => {
  S().addToQueue(['WIN1']);
  // Run 1: the box closed silently, and the confirmation pass hit an error.
  await harness({ 'WIN1@postmates': (opts) => { opts.onConfirm(); return { result: 'error', detail: 'Promo modal did not open' }; } }).run();
  assert.deepStrictEqual(S().getQueue(), ['WIN1']);
  // Run 2: the site now says it's already applied — that was run 1's win.
  await harness({ 'WIN1@postmates': { result: 'success', detail: 'Already applied' } }).run();
  assert.strictEqual(rows().WIN1, 'success: Applied!');
  assert.strictEqual(S().getFlags('WIN1').confirmPending, false);
});
