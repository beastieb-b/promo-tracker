const assert = require('assert');
const { test } = require('node:test');
require('./helpers').useTempData();
const { selectUSCFPosts, planUSCFRead, threadMonth, isNewerThread } = require('../src/reddit');

test('selectUSCFPosts: only requested, live, recent posts, in thread order', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  const day = 86400000;
  const at = (d) => new Date(now - d * day).toISOString();
  const posts = [
    { id: 105, postNumber: 6140, createdAt: at(1), text: 'RIOT924' },
    { id: 90, postNumber: 6120, createdAt: at(2), text: 'seen before' },       // <= high-water
    { id: 101, postNumber: 6131, createdAt: at(20), text: 'too old' },         // past 14 days
    { id: 102, postNumber: 6132, createdAt: at(3), text: 'x', deleted: true }, // deleted
    { id: 103, postNumber: 6133, createdAt: at(3), text: '' },                 // empty
    { id: 104, postNumber: 6134, createdAt: 'garbage', text: 'no date' },     // bad date
    { id: 100, postNumber: 6130, createdAt: at(5), text: '093GC' },
  ];
  const got = selectUSCFPosts(posts, new Set([100, 101, 102, 103, 104, 105]), now, 14).map(p => p.postNumber);
  assert.deepStrictEqual(got, [6130, 6140]);
});

test('selectUSCFPosts: first run (no high-water) still respects the age cutoff', () => {
  const now = Date.parse('2026-09-28T12:00:00Z');
  const posts = [
    { id: 1, postNumber: 1, createdAt: '2020-11-17T00:00:00Z', text: 'ancient' },
    { id: 2, postNumber: 2, createdAt: new Date(now - 86400000).toISOString(), text: 'fresh' },
  ];
  assert.deepStrictEqual(selectUSCFPosts(posts, null, now).map(p => p.id), [2]);
});

test('threadMonth: the month a thread is for, from its slug or title', () => {
  assert.strictEqual(threadMonth({ slug: 'monthly_existing_user_promo_code_thread_november_2026' }), '2026-11');
  assert.strictEqual(threadMonth({ title: 'Monthly Existing User Promo Code Thread - October 2026' }), '2026-10');
  assert.strictEqual(threadMonth({ slug: 'monthly_thread' }, new Date(2026, 2, 5)), '2026-03');
});

test('isNewerThread: base36 post ids grow over time', () => {
  assert.strictEqual(isNewerThread('1wvow4e', '1w44b0a'), true);
  assert.strictEqual(isNewerThread('1w44b0a', '1wvow4e'), false);
  assert.strictEqual(isNewerThread('1w44b0a', null), true);
});

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

test('planUSCFRead: a normal scan reads every unseen post', () => {
  const p = planUSCFRead({ stream: range(1, 100), lastSeenId: 95, maxPosts: 30, backlogLimit: 300 });
  assert.deepStrictEqual(p.ids, [96, 97, 98, 99, 100]);
  assert.deepStrictEqual(p.pending, []);
  assert.strictEqual(p.lastSeenId, 100);
});

test('planUSCFRead: after downtime the newest posts go first, older ones on later scans', () => {
  const first = planUSCFRead({ stream: range(1, 200), lastSeenId: 100, maxPosts: 30, backlogLimit: 300 });
  assert.deepStrictEqual(first.ids, range(171, 200));
  assert.deepStrictEqual(first.pending, range(101, 170));
  assert.strictEqual(first.skipped, 0);
  // Next scan: 3 brand-new posts first, then the newest 27 of the backlog.
  const next = planUSCFRead({ stream: range(1, 203), lastSeenId: first.lastSeenId, pending: first.pending, maxPosts: 30, backlogLimit: 300 });
  assert.deepStrictEqual(next.ids, [...range(144, 170), 201, 202, 203]);
  assert.deepStrictEqual(next.pending, range(101, 143));
});

test('planUSCFRead: first run and hopeless backlogs skip ahead (and say how many)', () => {
  const firstRun = planUSCFRead({ stream: range(1, 500), lastSeenId: 0, maxPosts: 30, backlogLimit: 300 });
  assert.deepStrictEqual(firstRun.ids, range(471, 500));
  assert.strictEqual(firstRun.skipped, 470);
  const behind = planUSCFRead({ stream: range(1, 900), lastSeenId: 100, pending: [50, 60], maxPosts: 30, backlogLimit: 300 });
  assert.deepStrictEqual(behind.ids, range(871, 900));
  assert.strictEqual(behind.skipped, 770 + 2);
  assert.deepStrictEqual(behind.pending, []);
});

test('planUSCFRead: deleted posts drop out of the backlog', () => {
  const stream = range(1, 120).filter(id => id !== 105);
  const p = planUSCFRead({ stream, lastSeenId: 120, pending: [104, 105, 106], maxPosts: 30, backlogLimit: 300 });
  assert.deepStrictEqual(p.ids, [104, 106]);
});
