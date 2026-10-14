const assert = require('assert');
const { test } = require('node:test');
const { monthKey, dateKey, previousMonthKey, monthStartMs } = require('../src/time');

test('month and date keys use the local calendar', () => {
  const d = new Date(2026, 0, 31, 23, 30); // Jan 31, 11:30 PM local
  assert.strictEqual(monthKey(d), '2026-01');
  assert.strictEqual(dateKey(d), '2026-01-31');
  assert.strictEqual(monthKey('not a date'), null);
});

test('previousMonthKey wraps the year', () => {
  assert.strictEqual(previousMonthKey('2026-01'), '2025-12');
  assert.strictEqual(previousMonthKey('2026-10'), '2026-09');
});

test('monthStartMs is local midnight on the 1st', () => {
  assert.strictEqual(monthStartMs(new Date(2026, 9, 14, 10)), new Date(2026, 9, 1).getTime());
});
