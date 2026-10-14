const assert = require('assert');
const { test } = require('node:test');
require('./helpers').useTempData();
const settings = require('../src/settings');

test('defaults are neutral: no home region, no aliases', () => {
  const s = settings.load();
  assert.strictEqual(s.homeRegion, '');
  assert.deepStrictEqual(s.homeAliases, []);
  assert.strictEqual(s.homeState, '');
});

test('normalizes unsupported intervals to fallback values', () => {
  assert.strictEqual(settings.normalizeInterval(1.5, settings.SCAN_INTERVALS, 2), 2);
  assert.strictEqual(settings.normalizeInterval(0.5, settings.SCAN_INTERVALS, 2), 0.5);
});

test('validate: bad values are errors, not silent no-ops', () => {
  assert.ok(settings.validate({ scanIntervalHours: 5 }).error);
  assert.ok(settings.validate({ homeRegion: 42 }).error);
  assert.ok(settings.validate({}).error);
  assert.deepStrictEqual(settings.validate({ scanIntervalHours: '0.5' }).updates, { scanIntervalHours: 0.5 });
});

test('save: home region, aliases (incl. the region itself) and state', () => {
  const s = settings.save({ homeRegion: ' Chicago ', homeAliases: 'Chi, chicagoland,chi', homeState: 'il' });
  assert.strictEqual(s.homeRegion, 'Chicago');
  assert.deepStrictEqual(s.homeAliases, ['chi', 'chicagoland', 'chicago']);
  assert.strictEqual(s.homeState, 'Illinois');
  // A new home without new aliases drops the old home's aliases.
  const t = settings.save({ homeRegion: 'Denver' });
  assert.deepStrictEqual(t.homeAliases, ['denver']);
  assert.strictEqual(t.homeState, 'Illinois');
});

test('setup checklist asks for a home region until one is set', () => {
  settings.save({ homeRegion: '' });
  settings.invalidateSetupStatus();
  const step = settings.getSetupStatus().steps.find(st => st.id === 'home-region');
  assert.strictEqual(step.done, false);
  assert.strictEqual(step.required, true);
  assert.ok(!settings.getSetupStatus().steps.some(st => st.id === 'old-cron'));
});

test('converts supported hour intervals to cron expressions', () => {
  assert.strictEqual(settings.hoursToCron(0.5), '*/30 * * * *');
  assert.strictEqual(settings.hoursToCron(1), '0 * * * *');
  assert.strictEqual(settings.hoursToCron(4), '0 */4 * * *');
  assert.strictEqual(settings.hoursToCron(24), '0 0 * * *');
});

test('computes wall-clock next run matching cron schedule', () => {
  const twoHours = settings.nextRunFromInterval(2, new Date(2026, 5, 6, 12, 45, 20));
  assert.strictEqual(twoHours.getHours(), 14);
  assert.strictEqual(twoHours.getMinutes(), 0);

  const halfHour = settings.nextRunFromInterval(0.5, new Date(2026, 5, 6, 12, 31, 20));
  assert.strictEqual(halfHour.getHours(), 13);
  assert.strictEqual(halfHour.getMinutes(), 0);
});

test('shouldApplyOnArrival: fires only for new codes with all guards clear', () => {
  const now = Date.parse('2026-07-03T12:00:00Z');
  const base = { queued: 2, applyRunning: false, lastApplyAt: null, lastRateLimitedAt: null, now };

  assert.strictEqual(settings.shouldApplyOnArrival(base), true);
  assert.strictEqual(settings.shouldApplyOnArrival({ ...base, queued: 0 }), false);
  assert.strictEqual(settings.shouldApplyOnArrival({ ...base, applyRunning: true }), false);
  assert.strictEqual(settings.shouldApplyOnArrival({ ...base, lastApplyAt: new Date(now - 10 * 60000) }), false);
  assert.strictEqual(settings.shouldApplyOnArrival({ ...base, lastApplyAt: new Date(now - 31 * 60000) }), true);
  assert.strictEqual(settings.shouldApplyOnArrival({
    ...base, lastApplyAt: new Date(now - 31 * 60000), lastRateLimitedAt: new Date(now - 60 * 60000),
  }), false);
  assert.strictEqual(settings.shouldApplyOnArrival({
    ...base, lastApplyAt: new Date(now - 31 * 60000), lastRateLimitedAt: new Date(now - 180 * 60000),
  }), true);
});
