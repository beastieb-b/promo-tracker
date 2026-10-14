// US states by postal abbreviation. Used to match a configured home state
// against promo locations written either way ("California" / "CA").
const US_STATES = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california',
  CO: 'colorado', CT: 'connecticut', DE: 'delaware', FL: 'florida', GA: 'georgia',
  HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa',
  KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland',
  MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi',
  MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada', NH: 'new hampshire',
  NJ: 'new jersey', NM: 'new mexico', NY: 'new york', NC: 'north carolina',
  ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania',
  RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee',
  TX: 'texas', UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington',
  WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming', DC: 'district of columbia',
};

// Normalize user input ("ca", "California ") to the full lowercase name, or
// null when it isn't a US state.
function stateName(input) {
  const s = String(input || '').trim().toLowerCase();
  if (!s) return null;
  const abbr = Object.keys(US_STATES).find(k => k.toLowerCase() === s || US_STATES[k] === s);
  return abbr ? US_STATES[abbr] : null;
}

function stateAbbr(name) {
  const n = stateName(name);
  return n ? Object.keys(US_STATES).find(k => US_STATES[k] === n) : null;
}

module.exports = { US_STATES, stateName, stateAbbr };
