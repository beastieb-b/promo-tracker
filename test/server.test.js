// HTTP-level checks of who may use the dashboard and the API contract.
const assert = require('assert');
const http = require('http');
const { test, before, after } = require('node:test');
require('./helpers').useTempData();
process.env.HOST = '0.0.0.0'; // network access on, so remote rules apply
const access = require('../src/access');
const server = require('../src/server');

let srv;
let port;
const running = { scan: false };

before(async () => {
  server.registerHooks({
    runScan: async () => ({}),
    runApply: async () => ({}),
    isScanRunning: () => running.scan,
    isApplyRunning: () => false,
    getScanStatus: () => ({ active: true }),
  });
  srv = server.app.listen(0, '127.0.0.1');
  await new Promise(r => srv.once('listening', r));
  port = srv.address().port;
});
after(() => srv.close());

function req(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port, method, path,
      headers: { host: `localhost:${port}`, ...(data ? { 'content-type': 'application/json' } : {}), ...headers },
    }, (res) => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const CLIENT = { 'x-promo-client': 'dashboard' };
const REMOTE = { 'x-forwarded-for': '192.168.1.20' }; // looks like another device

test('local requests work with a known Host', async () => {
  const r = await req('GET', '/api/meta');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.viewerIsLocal, true);
  assert.deepStrictEqual(r.json.scanIntervals, [0.5, 1, 2, 3, 4, 6, 12, 24]);
  assert.match(r.headers['content-security-policy'], /script-src 'self'/);
});

test('DNS rebinding: a local request naming a foreign Host is refused', async () => {
  const r = await req('GET', '/api/stats', { headers: { host: `evil.example:${port}` } });
  assert.strictEqual(r.status, 421);
  const page = await req('GET', '/', { headers: { host: 'evil.example' } });
  assert.strictEqual(page.status, 421);
});

test('mutations need the client header and a matching Origin', async () => {
  assert.strictEqual((await req('POST', '/api/queue/add', { body: { code: 'SAVE20' } })).status, 403);
  const cross = await req('POST', '/api/queue/add', { headers: { ...CLIENT, origin: 'https://evil.example' }, body: { code: 'SAVE20' } });
  assert.strictEqual(cross.status, 403);
  const ok = await req('POST', '/api/queue/add', { headers: { ...CLIENT, origin: `http://localhost:${port}` }, body: { code: 'save20' } });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(ok.json, { added: 1, code: 'SAVE20' });
  const queue = await req('GET', '/api/queue');
  assert.strictEqual(queue.json.queue[0].code, 'SAVE20');
  assert.strictEqual(queue.json.queue[0].priority, 1);
});

test('other devices need the access link; it sets a cookie and drops the token', async () => {
  assert.strictEqual((await req('GET', '/api/stats', { headers: REMOTE })).status, 401);
  const page = await req('GET', '/', { headers: REMOTE });
  assert.strictEqual(page.status, 401);
  assert.match(page.text, /Access link needed/);

  assert.strictEqual((await req('GET', '/?token=wrong', { headers: REMOTE })).status, 401);
  const token = access.getToken();
  const link = await req('GET', `/?token=${encodeURIComponent(token)}`, { headers: REMOTE });
  assert.strictEqual(link.status, 302);
  assert.strictEqual(link.headers.location, '/');
  const cookie = link.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);

  const withCookie = await req('GET', '/api/stats', { headers: { ...REMOTE, cookie: cookie.split(';')[0] } });
  assert.strictEqual(withCookie.status, 200);
  const bearer = await req('GET', '/api/meta', { headers: { ...REMOTE, authorization: `Bearer ${token}` } });
  assert.strictEqual(bearer.status, 200);
  assert.strictEqual(bearer.json.viewerIsLocal, false);
});

test('access links are only shown on the Mac itself', async () => {
  const local = await req('GET', '/api/access');
  assert.strictEqual(local.status, 200);
  assert.strictEqual(local.json.networkAccess, true);
  assert.ok(local.json.links.every(l => l.includes(`token=`)));
  const token = access.getToken();
  const remote = await req('GET', '/api/access', { headers: { ...REMOTE, authorization: `Bearer ${token}` } });
  assert.strictEqual(remote.status, 403);
});

test('settings: validation errors are 400; valid saves return the settings', async () => {
  const bad = await req('POST', '/api/settings', { headers: CLIENT, body: { scanIntervalHours: 5 } });
  assert.strictEqual(bad.status, 400);
  const good = await req('POST', '/api/settings', { headers: CLIENT, body: { homeRegion: 'Chicago', homeState: 'IL' } });
  assert.strictEqual(good.status, 200);
  assert.strictEqual(good.json.homeState, 'Illinois');
});

test('starting a scan while one runs is a 409, not a broadcast error', async () => {
  running.scan = true;
  const busy = await req('POST', '/api/run/reddit', { headers: CLIENT });
  assert.strictEqual(busy.status, 409);
  assert.strictEqual(busy.json.busy, true);
  running.scan = false;
  assert.strictEqual((await req('POST', '/api/run/reddit', { headers: CLIENT })).status, 202);
});

test('reclassify accepts only success / region_skip', async () => {
  const r = await req('POST', '/api/processed/SAVE20/reclassify', { headers: CLIENT, body: { result: 'rejected' } });
  assert.strictEqual(r.status, 400);
});

test('malformed input gets a short JSON error, never a stack trace', async () => {
  const badCookie = await req('GET', '/api/stats', { headers: { ...REMOTE, cookie: 'promo_access=%E0%A4%A' } });
  assert.strictEqual(badCookie.status, 401);
  const badJson = await new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/settings',
      headers: { host: `localhost:${port}`, 'content-type': 'application/json', 'x-promo-client': 'dashboard' } }, (res) => {
      let t = ''; res.on('data', c => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t }));
    });
    r.end('{not json');
  });
  assert.strictEqual(badJson.status, 400);
  assert.doesNotMatch(badJson.text, /at |\.js:/);
});
