// Calendar helpers in this machine's local time zone. Monthly threads, savings
// buckets and schedules all follow the clock the user lives on; set TZ in the
// environment to override.

const pad = (n) => String(n).padStart(2, '0');

function toDate(d) {
  return d instanceof Date ? d : new Date(d);
}

// 'YYYY-MM' for the local calendar month containing `d`.
function monthKey(d = new Date()) {
  const x = toDate(d);
  if (isNaN(x)) return null;
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}`;
}

// 'YYYY-MM-DD' local date.
function dateKey(d = new Date()) {
  const x = toDate(d);
  if (isNaN(x)) return null;
  return `${monthKey(x)}-${pad(x.getDate())}`;
}

// The month before a 'YYYY-MM' key.
function previousMonthKey(key) {
  const [y, m] = key.split('-').map(Number);
  return monthKey(new Date(y, m - 2, 1));
}

// Start of the local calendar month containing `d`, as epoch ms.
function monthStartMs(d = new Date()) {
  const x = toDate(d);
  return new Date(x.getFullYear(), x.getMonth(), 1).getTime();
}

function timeZoneName() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'; }
  catch { return 'local'; }
}

module.exports = { monthKey, dateKey, previousMonthKey, monthStartMs, timeZoneName };
