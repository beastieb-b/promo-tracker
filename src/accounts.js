// Accounts: each one is a separate Uber login (Postmates + Uber Eats) in its
// own Chrome profile, with its own queue, results and "already applied" list.
//
// The first account, `main`, always exists and keeps the original file
// locations in data/, so a single-account install never moves anything.
// Others live in data/accounts/<id>/. Multiple-account support is a setting
// (Settings → Multiple accounts); while it's off only `main` is used.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');
const { writeFileAtomic } = require('./atomic');

const MAIN = 'main';
const REGISTRY_FILE = path.join(cfg.DATA_DIR, 'accounts.json');
const ACCOUNTS_DIR = path.join(cfg.DATA_DIR, 'accounts');
const REMOVED_DIR = path.join(cfg.DATA_DIR, 'accounts-removed');

function pathsFor(id) {
  if (id === MAIN) {
    return {
      queue: cfg.QUEUE_FILE,
      processed: cfg.PROCESSED_FILE,
      ledger: cfg.APPLIED_LEDGER_FILE,
      session: cfg.SESSION_STATE_FILE,
      flags: path.join(cfg.DATA_DIR, 'code_flags.json'),
      profile: cfg.BROWSER_PROFILE_DIR,
      archive: cfg.ARCHIVE_DIR,
    };
  }
  const dir = path.join(ACCOUNTS_DIR, id);
  return {
    dir,
    queue: path.join(dir, 'queue.txt'),
    processed: path.join(dir, 'processed.txt'),
    ledger: path.join(dir, 'applied_codes.json'),
    session: path.join(dir, 'session_state.json'),
    flags: path.join(dir, 'code_flags.json'),
    profile: path.join(dir, 'browser-profile'),
    archive: path.join(dir, 'archive'),
  };
}

function readRegistry() {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')).accounts || []; } catch {}
  list = list.filter(a => a && typeof a.id === 'string' && /^[a-z0-9]{1,16}$/.test(a.id));
  if (!list.some(a => a.id === MAIN)) list.unshift({ id: MAIN, name: 'Account 1' });
  return list;
}

function writeRegistry(list) {
  fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
  writeFileAtomic(REGISTRY_FILE, JSON.stringify({ accounts: list.map(({ id, name, createdAt }) => ({ id, name, createdAt })) }, null, 2));
}

const withPaths = (a) => ({ id: a.id, name: a.name, createdAt: a.createdAt || null, paths: pathsFor(a.id) });

function list() {
  return readRegistry().map(withPaths);
}

function get(id) {
  const a = readRegistry().find(x => x.id === id);
  return a ? withPaths(a) : null;
}

function main() {
  return get(MAIN);
}

function enabled() {
  return require('./settings').load().multiAccount === true;
}

// The accounts the app works on right now.
function active() {
  return enabled() ? list() : [main()];
}

function cleanName(name) {
  const n = String(name ?? '').replace(/[\r\n\t]/g, ' ').trim();
  return n.length >= 1 && n.length <= 30 ? n : null;
}

function create(name) {
  const clean = cleanName(name);
  if (!clean) throw Object.assign(new Error('Account names are 1–30 characters'), { status: 400 });
  const accounts = readRegistry();
  let id;
  do { id = crypto.randomBytes(3).toString('hex'); } while (accounts.some(a => a.id === id));
  const account = { id, name: clean, createdAt: new Date().toISOString() };
  fs.mkdirSync(pathsFor(id).profile, { recursive: true });
  writeRegistry([...accounts, account]);
  return withPaths(account);
}

function rename(id, name) {
  const clean = cleanName(name);
  if (!clean) throw Object.assign(new Error('Account names are 1–30 characters'), { status: 400 });
  const accounts = readRegistry();
  const a = accounts.find(x => x.id === id);
  if (!a) throw Object.assign(new Error('No such account'), { status: 404 });
  a.name = clean;
  writeRegistry(accounts);
  return withPaths(a);
}

// Stop using an account. Its folder (Chrome login, history) is moved aside,
// not erased, so a mistaken removal can be undone by hand.
function remove(id) {
  if (id === MAIN) throw Object.assign(new Error('The first account can\'t be removed'), { status: 400 });
  const accounts = readRegistry();
  if (!accounts.some(a => a.id === id)) throw Object.assign(new Error('No such account'), { status: 404 });
  writeRegistry(accounts.filter(a => a.id !== id));
  const dir = pathsFor(id).dir;
  if (fs.existsSync(dir)) {
    fs.mkdirSync(REMOVED_DIR, { recursive: true });
    fs.renameSync(dir, path.join(REMOVED_DIR, `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  }
  return true;
}

module.exports = { MAIN, list, get, main, enabled, active, create, rename, remove, pathsFor, cleanName };
