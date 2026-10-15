const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const cfg = require('./config');
const state = require('./state');
const settings = require('./settings');
const session = require('./session');
const browser = require('./browser');
const access = require('./access');
const accounts = require('./accounts');
const stores = require('./store');
const stats = require('./stats');
const { timeZoneName, monthStartMs } = require('./time');

const app = express();
app.disable('x-powered-by');

// ── Security ─────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

const deniedHosts = new Set();
function denyPage(res, status, title, body) {
  res.status(status).type('html').send(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${title}</title><body style="font:16px system-ui;margin:40px auto;max-width:560px;padding:0 16px;color:#222">` +
    `<h2>${title}</h2><p>${body}</p></body>`);
}

// Who's asking (see access.js for the model).
app.use((req, res, next) => {
  const isApi = req.path.startsWith('/api/');
  if (access.isLocalRequest(req)) {
    // From this Mac: no token, but the Host must be one of ours. A web page
    // that re-points its own domain at 127.0.0.1 (DNS rebinding) fails here.
    if (access.hostAllowed(req.headers.host)) return next();
    const name = access.hostnameOf(req.headers.host);
    if (!deniedHosts.has(name)) {
      deniedHosts.add(name);
      state.appendLog({ type: 'access_denied', reason: 'unknown host', host: name.slice(0, 80) });
    }
    if (isApi) return res.status(421).json({ error: `Unknown host "${name}" — add it to "allowedHosts" in config.local.json` });
    return denyPage(res, 421, 'Unknown host', `Promo Tracker doesn't answer to "${name.replace(/[<>&"]/g, '')}". If that's a name for this Mac, add it to <code>allowedHosts</code> in <code>config.local.json</code> and restart.`);
  }

  // From another device: needs the access cookie (or a bearer token).
  if (access.hasAccess(req)) return next();
  if (req.method === 'GET' && typeof req.query.token === 'string' && access.tokenMatches(req.query.token)) {
    res.setHeader('Set-Cookie', access.accessCookie());
    return res.redirect(302, req.path); // drops the token from the address bar
  }
  if (isApi) return res.status(401).json({ error: 'This device needs the access link', auth: 'required' });
  return denyPage(res, 401, 'Access link needed',
    'Open the access link on this device once. On the Mac running Promo Tracker: Settings → Remote access, or run <code>npm run access-link</code>.');
});

// CSRF: every state-changing request must carry a custom header. Browsers
// can't add one cross-origin without a CORS preflight, which this server
// never approves; a stated Origin must also match the Host.
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers['x-promo-client'] !== 'dashboard') {
    return res.status(403).json({ error: 'Missing X-Promo-Client header' });
  }
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase(); } catch {}
    if (!ok) return res.status(403).json({ error: 'Cross-origin requests are not allowed' });
  }
  next();
});

app.use(express.json({ limit: '8kb' }));

// Never cache the dashboard's own files so updates load immediately.
app.use(express.static(path.join(cfg.APP_DIR, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(html|css|js)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-store');
  },
}));

// ── Live updates (SSE) ───────────────────────────────────────────────────────

const sseClients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

// Comment pings keep idle connections open through proxies and let dead
// clients (a laptop that went to sleep) be noticed and dropped.
setInterval(() => {
  for (const res of sseClients) {
    try { res.write(': ping\n\n'); } catch { sseClients.delete(res); }
  }
}, 25000).unref();

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  req.on('close', () => sseClients.delete(res));
});

// ── Hooks from the daemon ────────────────────────────────────────────────────

let hooks = {
  runScan: null,       // () => result; refuses with { busy } when one is running
  runApply: null,
  isScanRunning: () => false,
  isApplyRunning: () => false,
  reschedule: null,
  getScanStatus: () => null,
  shutdown: async () => {},
};

function registerHooks(h) { hooks = { ...hooks, ...h }; }

// ── Accounts ─────────────────────────────────────────────────────────────────

// Tri-state login status: a real navigation result wins; with none yet, a
// saved cookie means "unverified" (null) and no cookie means logged out.
function loginState(account, platform) {
  const v = session.get(platform, account.id);
  if (v === true || v === false) return v;
  return settings.cookieHints(account.paths.profile)[platform] ? null : false;
}

const worst = (vals) => (vals.includes(false) ? false : vals.includes(null) ? null : true);
const allStores = () => (accounts.enabled() ? stores.active() : [stores.main()]);

// Which accounts a read is about: ?account=<id>|all (only with multiple
// accounts on; otherwise always the first account). null = unknown account.
function selection(req) {
  if (!accounts.enabled()) return { selected: accounts.MAIN, stores: [stores.main()] };
  const want = String(req.query.account || 'all');
  if (want === 'all') return { selected: 'all', stores: stores.active() };
  const one = stores.forAccount(want);
  return one ? { selected: want, stores: [one] } : null;
}

// The single account a change applies to (?account=<id>; ignored when
// multiple accounts are off). Answers the request itself when it's missing.
function target(req, res) {
  if (!accounts.enabled()) {
    // A stale request (an Undo window that outlived turning the setting off)
    // must not land on the first account instead.
    if (req.query.account && req.query.account !== accounts.MAIN) {
      busy(res, 'Multiple accounts are turned off');
      return null;
    }
    return stores.main();
  }
  const one = req.query.account ? stores.forAccount(String(req.query.account)) : null;
  if (!one) res.status(400).json({ error: 'Which account? Add ?account=<id>' });
  return one;
}

function accountSummaries() {
  return stats.accountSummaries(allStores(), loginState);
}

const broadcastAccounts = () => broadcast({ type: 'accounts_updated', accounts: accountSummaries() });

// ── Read endpoints ───────────────────────────────────────────────────────────

app.get('/api/meta', (req, res) => {
  res.json({
    version: require('../package.json').version,
    scanIntervals: settings.SCAN_INTERVALS,
    applyIntervals: settings.APPLY_INTERVALS,
    reapplySkipDays: cfg.REAPPLY_SKIP_DAYS,
    maxCodesPerRun: cfg.MAX_CODES_PER_RUN,
    codeWaitMs: cfg.CODE_WAIT_MS,
    timezone: timeZoneName(),
    dailyCheckTime: cfg.DAILY_CHECK_LABEL,
    viewerIsLocal: access.isLocalRequest(req),
    networkAccess: access.networkAccess(),
  });
});

app.get('/api/access', (req, res) => {
  if (!access.isLocalRequest(req)) return res.status(403).json({ error: 'Only available on the Mac running Promo Tracker' });
  const networkAccess = access.networkAccess();
  res.json({
    networkAccess,
    links: access.accessLinks(),
    note: networkAccess
      ? 'Open a link once on each phone or laptop; it signs that browser in for a year. Anyone with the link can control the app — keep it private.'
      : 'Only this Mac can open the dashboard. To use it from your phone or another computer, set "host": "0.0.0.0" in config.local.json and restart.',
  });
});

app.get('/api/stats', (req, res) => {
  const sel = selection(req);
  if (!sel) return res.status(404).json({ error: 'No such account' });
  const summaries = accountSummaries();
  const picked = summaries.filter(a => sel.stores.some(st => st.account.id === a.id));
  res.json({
    ...stats.getStats(sel.stores),
    loggedIn: worst(picked.map(a => a.loggedIn)),
    ueLoggedIn: worst(picked.map(a => a.ueLoggedIn)),
    multiAccount: accounts.enabled(),
    selectedAccount: sel.selected,
    accounts: summaries,
    settings: settings.load(),
    setup: settings.getSetupStatus(),
    scanStatus: hooks.getScanStatus(),
    healthWarning: state.getHealthWarning(),
  });
});

app.get('/api/log', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
  res.json(state.getLog(limit));
});

app.get('/api/queue', (req, res) => {
  const sel = selection(req);
  if (!sel) return res.status(404).json({ error: 'No such account' });
  res.json({ queue: sel.stores.flatMap(st => st.getQueueDetails()) });
});

app.get('/api/processed', (req, res) => {
  const sel = selection(req);
  if (!sel) return res.status(404).json({ error: 'No such account' });
  const rows = sel.stores.flatMap(st => st.getProcessedDetails())
    .sort((a, b) => ((a.ts || '') < (b.ts || '') ? -1 : (a.ts || '') > (b.ts || '') ? 1 : 0));
  res.json({ processed: rows });
});

app.get('/api/settings', (req, res) => res.json(settings.load()));

// ── Changes ──────────────────────────────────────────────────────────────────

app.post('/api/settings', (req, res) => {
  const { updates, error } = settings.validate(req.body || {});
  if (error) return res.status(400).json({ error });
  const before = settings.load();
  const saved = settings.save(updates);
  if (hooks.reschedule && (updates.scanIntervalHours !== undefined || updates.applyIntervalHours !== undefined)) {
    hooks.reschedule(saved);
  }
  if (updates.multiAccount !== undefined && updates.multiAccount !== before.multiAccount) {
    state.appendLog({ type: 'multi_account', enabled: saved.multiAccount });
    broadcastAccounts();
    broadcast({ type: 'queue_updated' });
  }
  res.json(saved);
});

app.delete('/api/health-warning', (req, res) => {
  state.clearHealthWarning();
  broadcast({ type: 'health_warning_cleared' });
  res.json({ cleared: true });
});

const busy = (res, error) => res.status(409).json({ error, busy: true });

app.post('/api/run/reddit', (req, res) => {
  if (!hooks.runScan) return res.status(503).json({ error: 'Not ready yet' });
  if (hooks.isScanRunning()) return busy(res, 'A source scan is already running');
  res.status(202).json({ started: true });
  hooks.runScan().catch(err => broadcast({ type: 'error', message: err.message }));
});

app.post('/api/run/apply', (req, res) => {
  if (!hooks.runApply) return res.status(503).json({ error: 'Not ready yet' });
  if (hooks.isApplyRunning()) return busy(res, 'An apply run is already running');
  if (browser.isBusy()) return busy(res, `The browser is busy (${browser.holder()}) — try again in a moment`);
  res.status(202).json({ started: true });
  hooks.runApply().catch(err => broadcast({ type: 'error', message: err.message }));
});

app.post('/api/self-test', (req, res) => {
  if (browser.isBusy()) return busy(res, `The browser is busy (${browser.holder()}) — try again in a moment`);
  res.status(202).json({ started: true });
  const { testDetection } = require('./runner');
  broadcast({ type: 'self_test_progress', step: 'running' });
  testDetection()
    .then(result => broadcast({ type: 'self_test_done', ...result }))
    .catch(err => broadcast({ type: 'self_test_done', ok: false, error: err.message }));
});

app.post('/api/setup', (req, res) => {
  const body = req.body || {};
  const platform = body.target === 'ubereats' ? 'ubereats' : 'postmates';
  if (!accounts.enabled() && body.account && body.account !== accounts.MAIN) return busy(res, 'Multiple accounts are turned off');
  const account = accounts.enabled() ? accounts.get(String(body.account || accounts.MAIN)) : accounts.main();
  if (!account) return res.status(404).json({ error: 'No such account' });
  // The browser is single-tenant; answer "not now" in the response so the
  // button can reset and say why.
  if (browser.isBusy()) {
    return busy(res, browser.holder() === 'login'
      ? 'A login window is already open on the Mac'
      : 'The browser is busy (apply run or session check) — try again in a moment.');
  }
  res.status(202).json({ started: true });
  const who = { account: account.id, accountName: account.name };
  const { setupLogin, verifySession } = require('./login');
  (async () => {
    const { closed } = await setupLogin({ target: platform, accountId: account.id });
    settings.invalidateSetupStatus();
    if (closed === 'timeout') broadcast({ type: 'login_timeout', target: platform, ...who });
    const hints = settings.cookieHints(account.paths.profile);
    broadcast({ type: 'setup_done', target: platform, loggedIn: hints.postmates, ueLoggedIn: hints.ubereats, ...who });
    // Verify with a real navigation so the card doesn't sit at "Unverified"
    // until an apply run happens to exercise this site.
    const v = await verifySession(platform, account.id);
    broadcast({ type: 'session_verified', platform, ok: v.verified, error: v.error || null, ...who });
  })().catch(err => broadcast({ type: 'error', message: `Login failed: ${err.message}` }));
});

app.post('/api/queue/add', (req, res) => {
  const body = req.body || {};
  const code = state.normalizeCode(body.code);
  if (!code) return res.status(400).json({ error: 'A code is 4–32 letters, numbers, underscores or hyphens' });
  let into;
  if (!accounts.enabled() && body.account && body.account !== 'all' && body.account !== accounts.MAIN) {
    return busy(res, 'Multiple accounts are turned off');
  }
  if (!accounts.enabled()) into = [stores.main()];
  else if (!body.account || body.account === 'all') into = stores.active();
  else {
    const one = stores.forAccount(String(body.account));
    if (!one) return res.status(404).json({ error: 'No such account' });
    into = [one];
  }
  const entry = { code, sourceKey: 'manual', sourceLabel: 'Manual', statusHint: 'Added by hand', manual: true, lastSeenAt: new Date().toISOString() };
  const added = into.filter(st => st.addToQueue([entry]) > 0).length;
  broadcast({ type: 'queue_updated' });
  res.json({ added, code });
});

app.delete('/api/queue/:code', (req, res) => {
  const st = target(req, res);
  if (!st) return;
  const removed = st.removeFromQueue(req.params.code);
  broadcast({ type: 'queue_updated' });
  res.json({ removed });
});

app.delete('/api/processed/:code', (req, res) => {
  const st = target(req, res);
  if (!st) return;
  const deleted = st.deleteResult(req.params.code);
  broadcast({ type: 'processed_updated' });
  res.json({ deleted });
});

app.post('/api/processed/:code/requeue', (req, res) => {
  const st = target(req, res);
  if (!st) return;
  const requeued = st.requeueResult(req.params.code);
  broadcast({ type: 'queue_updated' });
  broadcast({ type: 'processed_updated' });
  res.json({ requeued });
});

app.post('/api/processed/:code/reclassify', (req, res) => {
  const st = target(req, res);
  if (!st) return;
  const { result } = req.body || {};
  if (!['success', 'region_skip'].includes(result)) {
    return res.status(400).json({ error: 'result must be "success" or "region_skip"' });
  }
  const updated = st.reclassifyResult(req.params.code, result);
  broadcast({ type: 'processed_updated' });
  res.json({ updated });
});

// Adding, renaming and removing accounts (only with multiple accounts on).
const multiOnly = (req, res, next) => (accounts.enabled() ? next() : busy(res, 'Turn on multiple accounts in Settings first'));
const sendError = (res, err) => res.status(err.status || 500).json({ error: err.message });

app.post('/api/accounts', multiOnly, (req, res) => {
  let account;
  try { account = accounts.create((req.body || {}).name); } catch (err) { return sendError(res, err); }
  // Give the new account this month's codes (it has no history, so nothing
  // is "already applied").
  // Codes already found expired on another account are skipped (expiry
  // isn't per account).
  // Only this calendar month's codes (last month's have mostly expired, which
  // is why the monthly reset archives them), and none another account already
  // found expired (expiry isn't per account).
  const cutoff = Math.max(Date.now() - cfg.REAPPLY_SKIP_DAYS * 86400000, monthStartMs());
  const expired = new Set(stores.active().flatMap(st => st.getProcessedDetails())
    .filter(r => r.result === 'rejected' && /^Code expired\b/.test(r.detail || '')).map(r => r.code));
  const catalog = state.getCodeCatalog();
  const recent = Object.keys(catalog.codes)
    .map(code => ({ ...stores.catalogMeta(catalog, code), code }))
    .filter(m => m.sourceKey !== 'manual' && !expired.has(m.code) && (Date.parse(m.lastSeenAt || '') || 0) >= cutoff);
  const queued = stores.store(account).addToQueue(recent);
  state.appendLog({ type: 'account_added', account: account.id, name: account.name, queued });
  broadcastAccounts();
  broadcast({ type: 'queue_updated' });
  res.json({ account: { id: account.id, name: account.name }, queued });
});

app.post('/api/accounts/:id', multiOnly, (req, res) => {
  let account;
  try { account = accounts.rename(req.params.id, (req.body || {}).name); } catch (err) { return sendError(res, err); }
  broadcastAccounts();
  res.json({ account: { id: account.id, name: account.name } });
});

app.delete('/api/accounts/:id', multiOnly, async (req, res) => {
  const account = accounts.get(req.params.id);
  if (!account) return res.status(404).json({ error: 'No such account' });
  if (account.id === accounts.MAIN) return res.status(400).json({ error: 'The first account can\'t be removed' });
  // Hold the browser so no run can open this account's Chrome while its
  // profile is being moved; close it first if it's the one that's open.
  const release = browser.acquire('account');
  if (!release) return busy(res, 'The browser is busy — try again after the current run');
  try {
    if (browser.currentProfile() === account.paths.profile) await browser.closeBrowser();
    accounts.remove(account.id);
  } catch (err) {
    return sendError(res, err);
  } finally {
    release();
  }
  session.forget(account.id);
  state.appendLog({ type: 'account_removed', account: account.id, name: account.name });
  broadcastAccounts();
  broadcast({ type: 'queue_updated' });
  res.json({ removed: true });
});

// ── Quit / restart ───────────────────────────────────────────────────────────
// Under launchd (KeepAlive) a plain exit is an instant restart, so Quit must
// unload the service; Restart is just an exit that launchd answers. Run any
// other way, Restart starts a detached copy of this process first.

const underLaunchd = () => process.env.XPC_SERVICE_NAME === cfg.SERVICE_LABEL;

app.post('/api/quit', (req, res) => {
  const mode = underLaunchd() ? 'launchd' : 'process';
  res.json({ stopping: true, mode });
  setTimeout(async () => {
    await hooks.shutdown();
    if (mode === 'launchd') {
      // launchd answers by sending SIGTERM, which runs the normal shutdown.
      spawn('launchctl', ['unload', settings.SERVICE_PLIST], { detached: true, stdio: 'ignore' }).unref();
      setTimeout(() => process.exit(0), 10000).unref();
    } else {
      process.exit(0);
    }
  }, 200);
});

app.post('/api/restart', (req, res) => {
  const mode = underLaunchd() ? 'launchd' : 'process';
  res.json({ restarting: true, mode });
  setTimeout(async () => {
    await hooks.shutdown();
    if (mode === 'process') {
      const fs = require('fs');
      const log = fs.openSync(path.join(cfg.DATA_DIR, 'daemon.log'), 'a');
      require('./lock').releaseLock();
      spawn(process.execPath, process.argv.slice(1), { cwd: cfg.APP_DIR, detached: true, stdio: ['ignore', log, log] }).unref();
    }
    process.exit(0);
  }, 200);
});

// Last stop for errors (malformed JSON bodies, anything unexpected): a short
// JSON answer, never Express's default page with a stack trace.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('Request failed:', req.method, req.path, err.message);
  res.status(status).json({ error: status < 500 ? 'Bad request' : 'Something went wrong' });
});

function start() {
  return new Promise((resolve, reject) => {
    const tryListen = (attemptsLeft) => {
      const srv = app.listen(cfg.DASHBOARD_PORT, cfg.DASHBOARD_HOST, () => {
        console.log(`📊 Dashboard: http://${cfg.DASHBOARD_HOST === '0.0.0.0' ? 'localhost' : cfg.DASHBOARD_HOST}:${cfg.DASHBOARD_PORT}` +
          (access.networkAccess() ? ' (network access on — other devices need the access link: npm run access-link)' : ''));
        resolve(srv);
      });
      srv.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
          // A previous instance hasn't released the port yet.
          console.log(`Port ${cfg.DASHBOARD_PORT} busy, retrying in 3s... (${attemptsLeft} left)`);
          srv.close();
          setTimeout(() => tryListen(attemptsLeft - 1), 3000);
        } else {
          reject(err);
        }
      });
    };
    tryListen(5);
  });
}

module.exports = { app, start, broadcast, registerHooks };
