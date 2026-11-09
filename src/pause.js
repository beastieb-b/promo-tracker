// Pause: hold every automatic browser job (scheduled scans and apply runs,
// apply-on-arrival, the daily check) while you use this Mac for something
// else. The dashboard keeps running. Saved to disk so a restart stays paused;
// an optional end time resumes on its own (the daemon sets the timer, and an
// end time in the past simply reads as "not paused").

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const cfg = require('./config');
const { writeFileAtomic } = require('./atomic');

const MAX_MINUTES = 7 * 24 * 60;
const file = () => path.join(cfg.DATA_DIR, 'pause.json');
const events = new EventEmitter();
events.setMaxListeners(0); // one per sleeping run, plus the daemon's

let cache; // undefined = not read yet; null = not paused

function read() {
  if (cache !== undefined) return cache;
  try {
    const p = JSON.parse(fs.readFileSync(file(), 'utf8'));
    cache = p && typeof p.pausedAt === 'string'
      ? { pausedAt: p.pausedAt, until: typeof p.until === 'string' ? p.until : null }
      : null;
  } catch {
    cache = null;
  }
  return cache;
}

/** { paused, pausedAt, until } — `until` null means "until resumed". */
function status(now = Date.now()) {
  const p = read();
  if (!p || (p.until && Date.parse(p.until) <= now)) return { paused: false, pausedAt: null, until: null };
  return { paused: true, pausedAt: p.pausedAt, until: p.until };
}

const isPaused = () => status().paused;

/** minutes: a whole number 1–10080, or null for "until resumed". Returns an error string or null. */
function validateMinutes(minutes) {
  if (minutes === null || minutes === undefined) return null;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) {
    return `Pause length must be 1–${MAX_MINUTES} minutes, or none for "until resumed"`;
  }
  return null;
}

// Pausing again while paused changes the end time but keeps the start.
function pause({ minutes = null, now = Date.now() } = {}) {
  const err = validateMinutes(minutes);
  if (err) throw new Error(err);
  const cur = status(now);
  const p = {
    pausedAt: cur.paused ? cur.pausedAt : new Date(now).toISOString(),
    until: minutes ? new Date(now + minutes * 60000).toISOString() : null,
  };
  writeFileAtomic(file(), JSON.stringify(p, null, 2) + '\n');
  cache = p;
  events.emit('paused', p);
  return status(now);
}

function resume() {
  const was = status().paused;
  try { fs.unlinkSync(file()); } catch {}
  cache = null;
  return { wasPaused: was };
}

// A sleep that ends early the moment the app is paused, so a run waiting
// between codes stops right away instead of holding Chrome for the full gap.
function sleepUnlessPaused(ms) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); events.off('paused', done); resolve(); };
    const timer = setTimeout(done, ms);
    events.on('paused', done);
  });
}

// For tests: forget the cached state (the file is the source of truth).
function _reset() { cache = undefined; }

module.exports = { status, isPaused, pause, resume, validateMinutes, sleepUnlessPaused, MAX_MINUTES, _reset };
