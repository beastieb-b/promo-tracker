// Reading the promo modal's verdict after a code is applied.
//
// The modal always shows text that has nothing to do with the code just typed:
// default promos ("$20 off", "10% off"), existing promos with locations and
// expiry dates, sometimes an offer. So only text that APPEARED after clicking
// Apply can describe the result: everything here works on the "fresh" lines —
// the after-text minus the before-text, counted line by line.

const { isUsableLocation, formatRegion } = require('./region');

// Each rejection signal: the phrase the site shows → the human-readable reason.
// Order matters — more specific phrases first.
const REJECTION_SIGNALS = [
  ['promotion code is not valid', 'Code not valid'],
  ['not valid', 'Code not valid'],
  ['not eligible', 'Not eligible for your account'],
  ['already been used', 'Already used'],
  ['already used', 'Already used'],
  ['expired', 'Code expired'],
  ['invalid', 'Invalid code'],
  ['oops', 'Error applying code'],
];

function findRejection(text) {
  for (const [phrase, reason] of REJECTION_SIGNALS) {
    if (text.includes(phrase)) return { phrase, reason };
  }
  return null;
}

const lines = (t) => String(t || '').toLowerCase().split('\n').map(l => l.trim()).filter(Boolean);

// Lines of `after` beyond what `before` already had (multiset difference, in
// order) — so a line repeated in a new detail sheet still counts as new.
// Also returns `block`: every after-line from the first new one on. A detail
// sheet that replaces a list can repeat lines the list had ("location",
// "las vegas", "expiration" for an earlier promo); the diff cancels those, the
// block keeps them in the sheet's own order.
function diffLines(after, before) {
  const counts = new Map();
  for (const l of lines(before)) counts.set(l, (counts.get(l) || 0) + 1);
  const all = lines(after);
  const fresh = [];
  let first = -1;
  all.forEach((l, i) => {
    const n = counts.get(l) || 0;
    if (n > 0) counts.set(l, n - 1);
    else { fresh.push(l); if (first < 0) first = i; }
  });
  return { fresh, block: first < 0 ? [] : all.slice(first) };
}

function freshLines(after, before) {
  return diffLines(after, before).fresh;
}

// The promo amount as "$20" or "10%", or null.
function extractSavings(text) {
  const t = String(text || '');
  const m =
    t.match(/enjoy\s+(\$\d+(?:\.\d+)?)\s+off/i) ||
    t.match(/enjoy\s+(\d+%)\s+off/i) ||
    t.match(/(\$\d+(?:\.\d+)?)\s+off\s+your/i) ||
    t.match(/save\s+(\$\d+(?:\.\d+)?)/i) ||
    t.match(/(\$\d+(?:\.\d+)?)\s+off/i) ||
    t.match(/(\d+%)\s+off/i);
  return m ? m[1].replace(/\s+/g, '') : null;
}

// The place in a location value: "las vegas, nv" → "las vegas",
// "new york city (manhattan)" → "new york city".
function placeOf(value) {
  const m = String(value || '').match(/^([a-z][a-z .'-]{1,40})/);
  return m ? m[1].trim() : null;
}

// The "Location" the applied promo's detail sheet shows, looked for in the
// newly added block (an existing promo's location above it is not this code's).
function sheetLocation(block) {
  for (let i = 0; i < block.length; i++) {
    const inline = block[i].match(/^location\s*:\s*(.+)$/);
    if (inline) return placeOf(inline[1]);
    if (block[i] === 'location' && block[i + 1]) return placeOf(block[i + 1]);
  }
  return null;
}

// Classify the modal text after applying, against the text captured before.
// Returns { result, detail } or null while undetermined.
function classify(text, before = '') {
  const { fresh, block } = diffLines(text, before);
  const f = fresh.join('\n');
  if (!f) return null;

  // Rate limit — highest priority, stops the whole run.
  if (/too\s*many|rate limit|slow down/.test(f)) {
    return { result: 'ratelimited', detail: 'Rate limit detected' };
  }

  // Uber's generic failure ("There was an error processing your request. If
  // this continues, please visit help.uber.com"). Could be an outage, so it's
  // an error (retried), not a rejection; a code that keeps getting it is
  // given up on after a few runs.
  if (/error processing your request|something went wrong on our end/.test(f)) {
    return { result: 'error', detail: 'Site error ("There was an error processing your request")' };
  }

  // "Oops, you already applied this promotion" — the code IS on the account,
  // so it's a win. Checked before the rejection scan, which would read the
  // "oops" as a generic error.
  if (/already applied|already redeemed/.test(f)) {
    return { result: 'success', detail: 'Already applied' };
  }

  const rejection = findRejection(f);
  if (rejection) return { result: 'rejected', detail: rejection.reason };
  if (/couldn'?t (be )?appl|not be applied|unable to|isn'?t valid|doesn'?t exist|no longer valid/.test(f)) {
    return { result: 'rejected', detail: 'Code not valid' };
  }

  // Success: a confirmation interstitial, or the applied promo's detail sheet
  // (an amount plus an Expiration section that weren't there before).
  const savings = extractSavings(f);
  const appliedSheet = !!savings && block.some(l => /\bexpiration\b/.test(l));
  const strongSuccess =
    f.includes('see eligible stores') ||
    f.includes('promo applied') ||
    f.includes('added to your account') ||
    f.includes('successfully applied') ||
    /you'?ll (get|enjoy|save)/.test(f) ||
    appliedSheet;
  if (!strongSuccess) return null;

  const amount = savings ? `${savings} off` : null;
  // A promo locked to a specific place other than home works only there:
  // applied, but excluded from savings.
  const loc = sheetLocation(block);
  if (loc && !isUsableLocation(loc)) {
    return { result: 'region_skip', detail: `${amount || 'Applied'} — ${formatRegion(loc)} only` };
  }
  return { result: 'success', detail: amount || 'Applied!' };
}

module.exports = { classify, freshLines, extractSavings, findRejection };
