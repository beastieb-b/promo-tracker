const assert = require('assert');
const { test } = require('node:test');
const { extractCodes } = require('../src/extractor');

test('extracts common promo code shapes', () => {
  assert.deepStrictEqual([...extractCodes(['code: SAVE20'])], ['SAVE20']);
  assert.deepStrictEqual([...extractCodes(['OneDay10 worked for me'])], ['ONEDAY10']);
  assert.deepStrictEqual([...extractCodes(['use ABCD for $5 off'])], ['ABCD']);
});

test('filters common false positives and markup fragments', () => {
  assert.deepStrictEqual([...extractCodes(['I tried FLAGSTAFF and it worked'])], []);
  assert.deepStrictEqual([...extractCodes(['promo: <IMG SRC=x ONERROR=alert(1)> $5 off'])], []);
});

// Real posts that exposed the "standalone word" rule matching any line that
// merely STARTS with a capitalized word (each was a wasted apply attempt).
test('prose lines starting with a capitalized word are not codes', () => {
  const prose = [
    'College codes are back:\n\n      Doctor Of Credit – 17 Sep 26\n  Update: 40% off 2 orders, up to $10 discount',
    'Grocery codes USA?',
    'Where are the codes mannn',
    'Ohio codes',
    'Toronto: it says promo claimed but I can’t find it in my promo wallet',
  ];
  for (const t of prose) assert.deepStrictEqual([...extractCodes([t])], [], t);
});

test('platform names in "Uber eats $10 off" are not codes', () => {
  assert.deepStrictEqual([...extractCodes(['Uber eats $10 off $20\n\nRIOT924'])], ['RIOT924']);
});

test('standalone codes on their own lines are all caught (none skipped)', () => {
  // The old rule consumed the newline after a match, so only every other
  // line of a list was extracted, and a code ending the text was missed.
  const got = [...extractCodes(['$10 off:\nFryday\nRestday\nWinnerdinner'])].sort();
  assert.deepStrictEqual(got, ['FRYDAY', 'RESTDAY', 'WINNERDINNER']);
  assert.deepStrictEqual([...extractCodes(['promo codes:\nBurgernow'])], ['BURGERNOW']);
  assert.deepStrictEqual([...extractCodes(['Burgernow - $10 off $20'])], ['BURGERNOW']);
});

test('real USCardForum posts yield exactly their codes', () => {
  const posts = [
    'RIOT917 10 off 20',
    'postmate 093GC 40%off 25+',
    'Postmates $25-$20 in Chicago: BRUINSFAIR, delivery only',
    'Postmates $35-$15 in Chicago, Las Vegas, New York City: SHARETHELOVE, delivery only',
    '拖延症 就 redeem 了一个账户 这个 promo 很吊 可以和 bogo 叠加',
    'oops。但是跳出一个50% off限时俩小时的',
  ];
  assert.deepStrictEqual([...extractCodes(posts)].sort(), ['093GC', 'BRUINSFAIR', 'RIOT917', 'SHARETHELOVE']);
});

// Real USCardForum posts (Oct 2026) whose noise got queued and burned apply slots.
test('clock times and zero-for-O words are not codes', () => {
  const expiry = '小号邮箱看到的：\n\nFOODLOVEMMQ\n\nExpires Oct 5, 2026 12:00AM PT. Valid for up to $20 off';
  assert.deepStrictEqual([...extractCodes([expiry])], ['FOODLOVEMMQ']);   // not 00AM
  assert.deepStrictEqual([...extractCodes(['0ops 应该是targeted'])], []);   // not 0OPS
  assert.deepStrictEqual([...extractCodes(['Starts at 5PM, code EATS20OFF'])], ['EATS20OFF']);
});
