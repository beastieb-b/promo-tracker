const assert = require('assert');
const { test } = require('node:test');
require('./helpers').useTempData();
const reads = require('../src/reads');

test('a cancelled scan cannot start new browser reads; other work is unaffected', async () => {
  const { ctx, promise } = reads.runScan(async () => {
    await new Promise(r => setTimeout(r, 5));
    return reads.fetchSubredditPosts('postmates').then(() => 'read', err => err.message);
  });
  ctx.cancelled = true; // what the daemon does when the scan overruns
  assert.match(await promise, /cancelled/);
  assert.strictEqual(reads.scanCancelled(), false, 'outside the scan nothing is cancelled');
});
