// Region restriction detection.
//
// Many Postmates/Uber Eats promo codes are targeted to a single metro and won't
// apply elsewhere. The user sets a home market (Settings → Home region, plus
// aliases and a home state); a code locked to anywhere else is useless to them.
// We read the comment a code came from, and the applied promo's "Location",
// and decide whether it's restricted to a non-home area.
//
// Detection from comments is deliberately conservative: we only flag when the
// text uses explicit restriction language ("vegas only", "only works in
// phoenix", "az-only") next to a non-home place. A bare "worked in Vegas"
// mention is NOT enough — that's just where one person tried it.

const settings = require('./settings');
const { stateName, stateAbbr } = require('./us-states');

// Metros and states whose "<place> only" restrictions we recognize in comments.
// Whatever matches the user's home (aliases or home state) is dropped at
// runtime, so the same list works for every home market. Short abbreviations
// are listed only where they're unambiguous in promo chatter.
const PLACES = [
  'los angeles', 'las vegas', 'vegas', '\\blv\\b', 'phoenix', 'scottsdale', 'tucson',
  'chicago', 'seattle', 'tacoma', 'dallas', 'houston', 'austin', 'san antonio',
  'miami', 'orlando', 'tampa', 'atlanta', 'boston', 'new york city', 'new york', '\\bnyc\\b',
  'manhattan', 'brooklyn', 'queens', 'portland', 'denver', 'sacramento',
  'san francisco', '\\bsf\\b', 'bay area', 'norcal', 'oakland', 'san jose', 'san diego',
  'detroit', 'nashville', 'memphis', 'philadelphia', 'philly', 'baltimore',
  'charlotte', 'minneapolis', 'cleveland', 'pittsburgh', 'washington dc', '\\bdc\\b',
  'nevada', '\\bnv\\b', 'arizona', '\\baz\\b', 'illinois', 'texas', '\\btx\\b', 'florida',
  'georgia', 'massachusetts', 'oregon', 'colorado', 'michigan', 'california',
];

// Phrasings that mean "usable anywhere in the US".
const NATIONAL_RE = /\b(nationwide|national|united states|usa|us|everywhere|all\s+locations?|anywhere|all\s+markets?)\b/i;

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Full state name, plus its postal abbreviation. The abbreviation is only
// trusted in a promo's Location field: in comment text "in", "or", "me", "ok",
// "oh" and "hi" are ordinary words.
function stateTerms(homeState) {
  const name = stateName(homeState);
  if (name) return { names: [name], abbrs: [stateAbbr(name).toLowerCase()] };
  const raw = String(homeState || '').trim().toLowerCase();
  return { names: raw ? [raw] : [], abbrs: [] };
}

const wordsRe = (terms) => (terms.length ? new RegExp('\\b(' + terms.map(escapeRe).join('|') + ')\\b', 'i') : null);

// Build the home matchers from the current settings. Apply runs and scans are
// infrequent, so re-reading settings keeps changes live without a restart;
// results are cached by the settings signature.
let _cache = { key: null };
function getHome() {
  const s = settings.load();
  const aliases = s.homeAliases || [];
  const state = stateTerms(s.homeState);
  const key = JSON.stringify([s.homeRegion, aliases, state]);
  if (_cache.key === key) return _cache;

  const aliasRe = wordsRe([...aliases, ...state.names]);                 // comment text
  const locationRe = wordsRe([...aliases, ...state.names, ...state.abbrs]); // Location field
  const places = PLACES.filter(p => !(locationRe && locationRe.test(p.replace(/\\b/g, ''))));
  _cache = {
    key,
    configured: !!s.homeRegion,
    label: s.homeRegion || 'your area',
    aliasRe,
    locationRe,
    placesRe: '(' + places.join('|') + ')',
  };
  return _cache;
}

const UPPER = new Set(['lv', 'nv', 'az', 'sf', 'tx', 'nyc', 'dc']);

function titleCase(s) {
  const lower = String(s).trim().toLowerCase();
  if (UPPER.has(lower)) return lower.toUpperCase();
  return lower.replace(/\b\w/g, c => c.toUpperCase());
}

// Returns { region, restricted, note } or null when there's no region signal.
//   restricted: true  → locked to a region OTHER than home
//   restricted: false → confirmed working in / limited to home (usable)
// With no home region configured there's nothing to compare against → null.
function detectRegionRestriction(text) {
  if (!text) return null;
  const home = getHome();
  if (!home.configured || !home.aliasRe) return null;
  const t = String(text).toLowerCase();
  const { label, aliasRe, placesRe } = home;

  const homeConfirmed = [
    new RegExp('\\b(?:works?|worked|valid|good|confirmed|used\\s+it)\\b[^.]{0,30}' + aliasRe.source, 'i'),
    new RegExp(aliasRe.source + '[^.]{0,25}\\b(?:works?|worked|valid|confirmed|here)\\b', 'i'),
    new RegExp(aliasRe.source + '\\s*[- ]?\\s*only\\b', 'i'),
  ];
  if (homeConfirmed.some(re => re.test(t))) {
    return { region: label, restricted: false, note: `Reported working in ${label}` };
  }

  const restrictionPatterns = [
    new RegExp(placesRe + '\\s*[- ]?\\s*only\\b', 'i'),
    new RegExp('\\bonly\\s+(?:works?|valid|good|available|usable)?\\s*(?:in|for|near)\\s+' + placesRe, 'i'),
    new RegExp('\\b(?:exclusive|targeted|limited|restricted)\\s+(?:to\\s+)?' + placesRe, 'i'),
    new RegExp(placesRe + '\\s+(?:residents|users|accounts|market|area)\\s+only\\b', 'i'),
  ];
  for (const pat of restrictionPatterns) {
    const m = t.match(pat);
    if (m && m[1]) {
      if (aliasRe.test(m[1])) continue;
      const city = titleCase(m[1].trim());
      return { region: city, restricted: true, note: `${city}-only — not valid in ${label}` };
    }
  }

  return null;
}

// Decide whether an applied promo's location is usable for the user.
// No location → usable. National → usable. Home (aliases or home state) →
// usable. Any other specific place → not. Without a configured home region we
// can't judge, so everything counts (the setup checklist asks for one).
function isUsableLocation(loc) {
  if (!loc) return true;
  const s = String(loc).toLowerCase().trim();
  if (NATIONAL_RE.test(s)) return true;
  const home = getHome();
  if (!home.configured || !home.locationRe) return true;
  return home.locationRe.test(s);
}

module.exports = { detectRegionRestriction, isUsableLocation, formatRegion: titleCase };
