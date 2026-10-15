// Whether each account's logins actually work, as learned from real
// navigation (not cookies): null = unknown, true = confirmed working, false =
// confirmed logged out. Persisted per account so the dashboard's status
// survives restarts.

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic');

const cache = new Map(); // account id → { postmates, ubereats }

function fileOf(accountId) {
  const account = require('./accounts').get(accountId);
  return account ? account.paths.session : null;
}

function load(accountId) {
  if (cache.has(accountId)) return cache.get(accountId);
  let s = { postmates: null, ubereats: null };
  try {
    const data = JSON.parse(fs.readFileSync(fileOf(accountId), 'utf8'));
    s = { postmates: data.sessionValid ?? null, ubereats: data.ueSessionValid ?? null };
  } catch {}
  cache.set(accountId, s);
  return s;
}

function get(platform, accountId = 'main') {
  return load(accountId)[platform] ?? null;
}

function set(platform, value, accountId = 'main') {
  const s = load(accountId);
  if (s[platform] === value) return;
  s[platform] = value;
  const file = fileOf(accountId);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify({ sessionValid: s.postmates, ueSessionValid: s.ubereats }));
  } catch {}
}

function forget(accountId) { cache.delete(accountId); }

module.exports = { get, set, forget };
