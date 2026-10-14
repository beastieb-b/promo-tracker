const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const dir = require('./helpers').useTempData();
const { detectRegionRestriction, isUsableLocation, formatRegion } = require('../src/region');

const setHome = (s) => fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(s));

test('no home region set: nothing is flagged, every location counts', () => {
  setHome({});
  assert.equal(detectRegionRestriction('VEGAS20 vegas only'), null);
  assert.equal(isUsableLocation('Las Vegas'), true);
});

test('Denver home: home / home state / national are usable, other places are not', () => {
  setHome({ homeRegion: 'Denver', homeAliases: ['mile high', 'front range'], homeState: 'CO' });
  for (const loc of ['Denver', 'Mile High', 'Front Range', 'Colorado', 'CO', 'Nationwide', 'United States', 'USA', 'Everywhere', null, '']) {
    assert.equal(isUsableLocation(loc), true, `${loc} should be usable`);
  }
  for (const loc of ['Las Vegas', 'Phoenix', 'San Francisco', 'Los Angeles', 'New York', 'Seattle', 'Texas']) {
    assert.equal(isUsableLocation(loc), false, `${loc} should not be usable`);
  }
});

test('Denver home: comment restrictions', () => {
  setHome({ homeRegion: 'Denver', homeAliases: ['mile high'], homeState: 'Colorado' });
  assert.equal(detectRegionRestriction('VEGAS20 vegas only').restricted, true);
  assert.equal(detectRegionRestriction('CODE only works in phoenix').restricted, true);
  assert.equal(detectRegionRestriction('SAVE worked in denver').restricted, false);
  assert.equal(detectRegionRestriction('colorado only').restricted, false, 'home state is not a restriction');
  assert.equal(detectRegionRestriction('SPRING worked in vegas for me'), null, 'a bare mention is not a restriction');
});

test('Chicago home: an LA-only code is region-locked, California is not home', () => {
  setHome({ homeRegion: 'Chicago', homeAliases: ['chi', 'chicagoland'], homeState: 'Illinois' });
  const r = detectRegionRestriction('BRUINS25 los angeles only');
  assert.equal(r.restricted, true);
  assert.equal(r.region, 'Los Angeles');
  assert.equal(isUsableLocation('California'), false);
  assert.equal(isUsableLocation('Illinois'), true);
  assert.equal(isUsableLocation('IL'), true);
  assert.equal(isUsableLocation('Chicago'), true);
  assert.equal(detectRegionRestriction('works in chicago').restricted, false);
});

test('formatRegion: uppercases known abbreviations', () => {
  assert.equal(formatRegion('lv'), 'LV');
  assert.equal(formatRegion('las vegas'), 'Las Vegas');
});

test('a home-state abbreviation that is a common word ("in", "or") never matches comment text', () => {
  setHome({ homeRegion: 'Indianapolis', homeAliases: ['indy'], homeState: 'IN' });
  assert.strictEqual(detectRegionRestriction('only works in vegas').restricted, true);
  assert.strictEqual(isUsableLocation('IN'), true);
  assert.strictEqual(isUsableLocation('Indiana'), true);
  setHome({ homeRegion: 'Las Vegas', homeAliases: ['vegas', 'lv'], homeState: 'NV' });
  assert.strictEqual(detectRegionRestriction('NV only'), null, 'the home state abbreviation is not another place');
});
