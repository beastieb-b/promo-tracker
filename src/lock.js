// One process at a time may drive the app's Chrome profile and state files:
// the daemon, or a one-off CLI run (--apply, --reddit, --setup). A second one
// would fight over the profile lock and interleave writes.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const cfg = require('./config');

// Alive AND still this app (after a crash or reboot the old pid may belong to
// something else by now — trusting it would keep the daemon from starting).
function holdsLock(pid) {
  try { process.kill(pid, 0); } catch (err) { if (err.code !== 'EPERM') return false; }
  try {
    const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { timeout: 3000 }).toString();
    return /index\.js/.test(cmd);
  } catch {
    return false;
  }
}

// Returns null on success, or { pid, role } of the live process holding it.
function acquireLock(role) {
  fs.mkdirSync(path.dirname(cfg.LOCK_FILE), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(cfg.LOCK_FILE, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, role, since: new Date().toISOString() }));
      fs.closeSync(fd);
      process.on('exit', releaseLock);
      return null;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let held = {};
      try { held = JSON.parse(fs.readFileSync(cfg.LOCK_FILE, 'utf8')); } catch {}
      if (held.pid && held.pid !== process.pid && holdsLock(held.pid)) return held;
      try { fs.unlinkSync(cfg.LOCK_FILE); } catch {} // stale (crash / reboot)
    }
  }
  return { pid: '?', role: 'unknown' };
}

function releaseLock() {
  try {
    const held = JSON.parse(fs.readFileSync(cfg.LOCK_FILE, 'utf8'));
    if (held.pid === process.pid) fs.unlinkSync(cfg.LOCK_FILE);
  } catch {}
}

module.exports = { acquireLock, releaseLock };
