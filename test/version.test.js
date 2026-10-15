const assert = require('assert');
const { test } = require('node:test');
require('./helpers').useTempData();
const version = require('../src/version');

test('version info: package version, start time, and no restart needed at start', () => {
  const v = version.info();
  assert.strictEqual(v.version, require('../package.json').version);
  assert.ok(!isNaN(Date.parse(v.startedAt)));
  assert.strictEqual(v.restartNeeded, false);
  assert.match(version.label(), /^v\d+\.\d+\.\d+/);
});
