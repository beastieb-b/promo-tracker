// Whether each site's login actually works, as learned from real navigation
// (not cookies): null = unknown, true = confirmed working, false = confirmed
// logged out. Persisted so the dashboard's status survives restarts.

const cfg = require('./config');
const { writeFileAtomic } = require('./atomic');

let _state = (() => {
  try {
    const data = JSON.parse(require('fs').readFileSync(cfg.SESSION_STATE_FILE, 'utf8'));
    return { postmates: data.sessionValid ?? null, ubereats: data.ueSessionValid ?? null };
  } catch { return { postmates: null, ubereats: null }; }
})();

function persist() {
  try {
    writeFileAtomic(cfg.SESSION_STATE_FILE, JSON.stringify({ sessionValid: _state.postmates, ueSessionValid: _state.ubereats }));
  } catch {}
}

function get(platform) { return _state[platform] ?? null; }

function set(platform, value) {
  if (_state[platform] === value) return;
  _state[platform] = value;
  persist();
}

module.exports = { get, set };
