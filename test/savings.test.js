const { test } = require('node:test');
const assert = require('node:assert');
require('./helpers').useTempData();
const { parseSavings, sumSavings } = require('../src/state');

test('parseSavings: extracts fixed-dollar amounts only', () => {
  assert.equal(parseSavings('$20 off'), 20);
  assert.equal(parseSavings('$12.50 off'), 12.5);
  assert.equal(parseSavings('$10 off — Las Vegas only'), 10);
  assert.equal(parseSavings('$15 off · UberEats'), 15);          // platform suffix
  assert.equal(parseSavings('$10 off — Las Vegas only · UberEats'), 10);
  assert.equal(parseSavings('10% off'), 0);   // percentages have no fixed value
  assert.equal(parseSavings('Applied!'), 0);
  assert.equal(parseSavings(null), 0);
});

test('sumSavings: totals only the dollar amounts of success rows', () => {
  const successes = [
    { detail: '$20 off' },
    { detail: '$15 off' },
    { detail: '10% off' },   // counts as 0
    { detail: 'Applied!' },  // counts as 0
  ];
  assert.equal(sumSavings(successes), 35);
});
