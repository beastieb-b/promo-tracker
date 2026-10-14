const assert = require('assert');
const { test } = require('node:test');
require('./helpers').useTempData({ homeRegion: 'Denver', homeAliases: ['mile high'], homeState: 'Colorado' });
const { classify, freshLines, extractSavings } = require('../src/classify');

// "Oops, you already applied this promotion" — the code is on the account, so
// it must classify as a win even though the message also contains "oops".
test('classify: "already applied this promotion" is a success', () => {
  const r = classify('promotions\noops, you already applied this promotion\napply', 'promotions\napply');
  assert.deepStrictEqual(r, { result: 'success', detail: 'Already applied' });
});

test('classify: a plain "oops" error is still a rejection', () => {
  assert.deepStrictEqual(classify('oops, something went wrong', ''), { result: 'rejected', detail: 'Error applying code' });
});

test('classify: expired / invalid codes reject', () => {
  assert.equal(classify('this promo has expired', '').detail, 'Code expired');
  assert.equal(classify('promotion code is not valid', '').detail, 'Code not valid');
});

test('classify: rate limit stops the run', () => {
  assert.equal(classify('too many requests, slow down', '').result, 'ratelimited');
});

test('classify: nothing new after Apply is undetermined', () => {
  const modal = 'promotions\n$20 off\n10% off your order\napply';
  assert.equal(classify(modal, modal), null);
});

// The modal always lists promos already on the account; their amounts and
// words must never be read as this code's result.
test('classify: text that was already there is ignored', () => {
  const before = 'promotions\nenjoy 30% off\nsee eligible stores\nexpired yesterday\napply';
  assert.equal(classify(before, before), null);
  const after = before + '\npromotion code is not valid';
  assert.deepStrictEqual(classify(after, before), { result: 'rejected', detail: 'Code not valid' });
});

test('classify: the amount comes only from the new detail sheet', () => {
  const before = 'promotions\n30% off\n$20 off\napply';
  const after = 'promotions\n30% off\n$20 off\nenjoy $15 off\nexpiration\noct 31\napply';
  assert.deepStrictEqual(classify(after, before), { result: 'success', detail: '$15 off' });
});

test('classify: a repeated line still counts as new (multiset diff)', () => {
  assert.deepStrictEqual(freshLines('$20 off\n$20 off\nexpiration', '$20 off'), ['$20 off', 'expiration']);
  assert.deepStrictEqual(classify('enjoy $20 off\nenjoy $20 off\nexpiration', 'enjoy $20 off'), { result: 'success', detail: '$20 off' });
});

test('classify: percentage amounts are formatted once ("10% off", not "10% off off")', () => {
  assert.equal(extractSavings('get 10% off your order'), '10%');
  assert.deepStrictEqual(classify('promo applied\n10% off', ''), { result: 'success', detail: '10% off' });
});

test('classify: a location outside home makes it region_skip; home state counts', () => {
  const sheet = (loc) => `enjoy $10 off\nexpiration\njun 21\nlocation\n${loc}\ndetails`;
  assert.deepStrictEqual(classify(sheet('las vegas'), ''), { result: 'region_skip', detail: '$10 off — Las Vegas only' });
  assert.deepStrictEqual(classify(sheet('colorado'), ''), { result: 'success', detail: '$10 off' });
  assert.deepStrictEqual(classify(sheet('denver'), ''), { result: 'success', detail: '$10 off' });
  assert.deepStrictEqual(classify(sheet('united states'), ''), { result: 'success', detail: '$10 off' });
});

test('classify: an existing promo\'s location in the list is not this code\'s', () => {
  const before = 'promotions\nlocation\nlas vegas\napply';
  const after = before + '\npromo applied\nsee eligible stores';
  assert.deepStrictEqual(classify(after, before), { result: 'success', detail: 'Applied!' });
});

test('classify: Uber\'s generic "error processing your request" is a retryable error', () => {
  const before = 'promotions\napply\nadd new promotions\n20% off (up to $20) liquor';
  const after = before + '\nthere was an error processing your request. if this continues, please visit help.uber.com';
  assert.strictEqual(classify(after, before).result, 'error');
});

test('classify: locations with a state or note still count as region-locked', () => {
  const sheet = (loc) => `enjoy $10 off\nexpiration\njun 21\nlocation\n${loc}\ndetails`;
  assert.deepStrictEqual(classify(sheet('las vegas, nv'), ''), { result: 'region_skip', detail: '$10 off — Las Vegas only' });
  assert.deepStrictEqual(classify(sheet('phoenix, az'), ''), { result: 'region_skip', detail: '$10 off — Phoenix only' });
  assert.strictEqual(classify(sheet('new york city (manhattan)'), '').result, 'region_skip');
  assert.strictEqual(classify('enjoy $10 off\nexpiration\nlocation: las vegas, nv', '').result, 'region_skip');
});

test('classify: a detail sheet replacing a list that showed the same city is still read', () => {
  const before = 'promotions\nenjoy $5 off\nexpiration\noct 9\nlocation\nlas vegas\napply';
  const after = 'enjoy $10 off\nexpiration\noct 31\nlocation\nlas vegas\ndetails';
  assert.deepStrictEqual(classify(after, before), { result: 'region_skip', detail: '$10 off — Las Vegas only' });
});
