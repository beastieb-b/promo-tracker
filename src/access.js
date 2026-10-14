// Who may use the dashboard.
//
// - By default the server listens on 127.0.0.1 only: just this Mac.
// - Every request must name an expected Host (this machine's names/IPs, or
//   one listed in config.local.json "allowedHosts"). That blocks DNS-rebinding
//   attacks, where a web page you visit points its own domain at 127.0.0.1.
// - With "host": "0.0.0.0" other devices can connect, and each needs the
//   access link once: /?token=… sets a long-lived cookie for that browser.
//   Requests from this Mac itself need no token.

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const cfg = require('./config');

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];
const COOKIE = 'promo_access';

function networkAccess() {
  return !['127.0.0.1', 'localhost', '::1'].includes(cfg.DASHBOARD_HOST);
}

function isLoopbackAddress(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// A request is "local" when it comes from this Mac AND didn't pass through a
// proxy (a proxy on this Mac — e.g. `tailscale serve` — would make every
// remote visitor look local).
function isLocalRequest(req) {
  if (req.headers['x-forwarded-for'] || req.headers.forwarded) return false;
  return isLoopbackAddress(req.socket.remoteAddress);
}

function interfaceAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.internal) continue;
      if (a.family === 'IPv4' || a.family === 4) out.push(a.address);
      else if (!a.address.startsWith('fe80')) out.push(`[${a.address}]`);
    }
  }
  return out;
}

function machineNames() {
  const full = os.hostname().toLowerCase();
  const short = full.split('.')[0];
  return [...new Set([short, `${short}.local`, full])];
}

let _allowed = null;
function allowedHostnames() {
  if (!_allowed) {
    _allowed = new Set([...LOOPBACK_HOSTS, ...machineNames(), ...interfaceAddresses(), ...cfg.ALLOWED_HOSTS]);
  }
  return _allowed;
}

// "plexbox:8766" → "plexbox"; "[::1]:8766" → "[::1]".
function hostnameOf(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.replace(/:\d+$/, '');
}

function hostAllowed(hostHeader) {
  const name = hostnameOf(hostHeader);
  if (!name) return false;
  if (allowedHostnames().has(name)) return true;
  // Interface addresses can change (DHCP, VPN up/down) — refresh once.
  _allowed = null;
  return allowedHostnames().has(name);
}

// The access token: config/env, else one generated on first use and kept in
// data/access_token (readable only by this user).
let _token = null;
function getToken() {
  if (_token) return _token;
  if (cfg.ACCESS_TOKEN) return (_token = String(cfg.ACCESS_TOKEN));
  try {
    const saved = fs.readFileSync(cfg.ACCESS_TOKEN_FILE, 'utf8').trim();
    if (saved.length >= 20) return (_token = saved);
  } catch {}
  _token = crypto.randomBytes(24).toString('base64url');
  fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
  fs.writeFileSync(cfg.ACCESS_TOKEN_FILE, _token + '\n', { mode: 0o600 });
  return _token;
}

function tokenMatches(candidate) {
  if (!candidate) return false;
  const a = crypto.createHash('sha256').update(String(candidate)).digest();
  const b = crypto.createHash('sha256').update(getToken()).digest();
  return crypto.timingSafeEqual(a, b);
}

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

function hasAccess(req) {
  if (tokenMatches(cookieValue(req, COOKIE))) return true;
  const auth = String(req.headers.authorization || '');
  return auth.startsWith('Bearer ') && tokenMatches(auth.slice(7).trim());
}

function accessCookie() {
  return `${COOKIE}=${encodeURIComponent(getToken())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
}

// Access links for other devices: configured names first, then this
// machine's name, then its addresses.
function accessLinks() {
  if (!networkAccess()) return [];
  const hosts = [...cfg.ALLOWED_HOSTS, ...machineNames().slice(0, 2), ...interfaceAddresses()];
  return [...new Set(hosts)].map(h => `http://${h}:${cfg.DASHBOARD_PORT}/?token=${encodeURIComponent(getToken())}`);
}

module.exports = {
  networkAccess, isLocalRequest, hostAllowed, hostnameOf,
  getToken, tokenMatches, hasAccess, accessCookie, accessLinks, COOKIE,
};
