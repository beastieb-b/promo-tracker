// Pause: the saved state, the apply run stopping at the next code, and the API.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { test, beforeEach, before, after } = require('node:test');
const dir = require('./helpers').useTempData();
const state = require('../src/state');
const pause = require('../src/pause');
const S = () => require('../src/store').main();
const { runApplyCodes } = require('../src/runner');
const server = require('../src/server');

beforeEach(() => {
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  state.ensureDirs();
  pause._reset();
});

test('pause state: timed and open-ended, saved to disk, ends on its own', () => {
  const t0 = Date.parse('2026-11-09T16:00:00Z');
  assert.strictEqual(pause.status(t0).paused, false);

  const st = pause.pause({ minutes: 60, now: t0 });
  assert.deepStrictEqual(st, { paused: true, pausedAt: '2026-11-09T16:00:00.000Z', until: '2026-11-09T17:00:00.000Z' });
  pause._reset(); // a restart reads it back from disk
  assert.strictEqual(pause.status(t0 + 59 * 60000).paused, true);
  assert.strictEqual(pause.status(t0 + 60 * 60000).paused, false);

  // Changing the length keeps the original start; null = until resumed.
  const again = pause.pause({ minutes: null, now: t0 + 10 * 60000 });
  assert.strictEqual(again.pausedAt, '2026-11-09T16:00:00.000Z');
  assert.strictEqual(again.until, null);
  assert.strictEqual(pause.status(t0 + 30 * 86400000).paused, true);

  assert.deepStrictEqual(pause.resume(), { wasPaused: true });
  assert.strictEqual(pause.isPaused(), false);
  assert.ok(!fs.existsSync(path.join(dir, 'pause.json')));
  assert.deepStrictEqual(pause.resume(), { wasPaused: false });
});

test('pause length is validated', () => {
  for (const bad of [0, -5, 1.5, 7 * 24 * 60 + 1, NaN, '60']) {
    assert.ok(pause.validateMinutes(bad), `should refuse ${bad}`);
    assert.throws(() => pause.pause({ minutes: bad }));
  }
  assert.strictEqual(pause.validateMinutes(null), null);
  assert.strictEqual(pause.validateMinutes(7 * 24 * 60), null);
  assert.strictEqual(pause.isPaused(), false);
});

test('the gap between codes ends as soon as the app is paused', async () => {
  const started = Date.now();
  const nap = pause.sleepUnlessPaused(60000);
  setTimeout(() => pause.pause({ minutes: 5 }), 20);
  await nap;
  assert.ok(Date.now() - started < 5000);
});

function harness(script, extra = {}) {
  const calls = [];
  const deps = {
    acquire: () => () => {},
    getPage: async () => ({}),
    closePage: async () => {},
    screenshot: async () => {},
    sleep: async () => {},
    applyCode: async (page, code, platform) => {
      calls.push(`${code}@${platform}`);
      const v = script[`${code}@${platform}`];
      if (typeof v === 'function') return v();
      if (!v) throw new Error(`unscripted ${code}@${platform}`);
      return v;
    },
    ...extra,
  };
  return { calls, run: () => runApplyCodes({ deps }) };
}

test('paused before the run: nothing is tried and the queue is untouched', async () => {
  S().addToQueue(['AAA1', 'BBB2']);
  pause.pause({ minutes: 30 });
  const h = harness({});
  const r = await h.run();
  assert.deepStrictEqual(h.calls, []);
  assert.strictEqual(r.stoppedForPause, true);
  assert.strictEqual(r.applied, 0);
  assert.deepStrictEqual(S().getQueue(), ['AAA1', 'BBB2']);
});

test('paused mid-run: the current code finishes (Uber Eats try included), the rest stay queued', async () => {
  S().addToQueue(['AAA1', 'BBB2', 'CCC3']);
  const h = harness({
    'AAA1@postmates': () => { pause.pause({ minutes: null }); return { result: 'rejected', detail: 'Code not valid' }; },
    'AAA1@ubereats': { result: 'success', detail: '$5 off' },
  });
  const r = await h.run();
  assert.deepStrictEqual(h.calls, ['AAA1@postmates', 'AAA1@ubereats']);
  assert.strictEqual(r.stoppedForPause, true);
  assert.strictEqual(r.applied, 1);
  assert.deepStrictEqual(S().getQueue(), ['BBB2', 'CCC3']);
  assert.ok(state.getLog(20).some(e => e.type === 'apply_paused' && e.codes_preserved === 2));
});

// ── API ──────────────────────────────────────────────────────────────────────

let srv;
let port;
const hookCalls = [];

before(async () => {
  server.registerHooks({
    runScan: async () => ({}),
    runApply: async () => ({}),
    isScanRunning: () => false,
    isApplyRunning: () => false,
    getScanStatus: () => ({ active: true, pause: pause.status() }),
    pause: (minutes) => { hookCalls.push(['pause', minutes]); return pause.pause({ minutes }); },
    resume: (how) => { hookCalls.push(['resume', how]); return { resumed: pause.resume().wasPaused, catchingUp: false }; },
  });
  srv = server.app.listen(0, '127.0.0.1');
  await new Promise(r => srv.once('listening', r));
  port = srv.address().port;
});
after(() => srv.close());

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port, method, path: p,
      headers: { host: `localhost:${port}`, 'x-promo-client': 'dashboard', ...(data ? { 'content-type': 'application/json' } : {}) },
    }, (res) => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text || 'null') }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

test('API: pause, runs refused while paused, resume', async () => {
  assert.strictEqual((await req('POST', '/api/pause', { minutes: 0 })).status, 400);
  assert.strictEqual((await req('POST', '/api/pause', { minutes: '60' })).status, 400);

  const p = await req('POST', '/api/pause', { minutes: 120 });
  assert.strictEqual(p.status, 200);
  assert.strictEqual(p.json.paused, true);
  assert.ok(p.json.until);
  assert.strictEqual(p.json.scanStatus.pause.paused, true);

  for (const route of ['/api/run/reddit', '/api/run/apply', '/api/self-test']) {
    const r = await req('POST', route);
    assert.strictEqual(r.status, 409, route);
    assert.strictEqual(r.json.paused, true, route);
  }

  const open = await req('POST', '/api/pause', {});
  assert.strictEqual(open.json.until, null);

  const r = await req('POST', '/api/resume');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.resumed, true);
  assert.strictEqual(r.json.scanStatus.pause.paused, false);
  assert.strictEqual((await req('POST', '/api/run/reddit')).status, 202);
  assert.deepStrictEqual(hookCalls, [['pause', 120], ['pause', null], ['resume', 'manual']]);
});
