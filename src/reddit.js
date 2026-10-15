const { execFile } = require('child_process');
const cfg = require('./config');
const state = require('./state');
const browser = require('./browser');
const reads = require('./reads');
const stores = require('./store');
const { extractCodesWithContext } = require('./extractor');
const { detectRegionRestriction } = require('./region');
const { monthKey } = require('./time');

const SOURCE_LABELS = {
  reddit_postmates: 'Reddit · Postmates',
  reddit_ubereats: 'Reddit · UberEATS',
  uscf: 'USCardForum',
};

function getCheerio() {
  try {
    return require('cheerio');
  } catch (err) {
    throw new Error(`cheerio is required for HTML parsing: ${err.message}`);
  }
}

// Use curl instead of Node.js https — Reddit TLS-fingerprints the Node.js stack
// and returns 403 even with matching headers. curl uses the system TLS and works.
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '-s', '--max-time', '25', '-L',
      '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      '-H', 'Accept-Language: en-US,en;q=0.5',
      '-w', '\n__STATUS__:%{http_code}',
      url,
    ];

    execFile('curl', args, { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }, (err, stdout) => {
      if (err) return reject(new Error(`curl failed: ${err.message}`));
      const statusMatch = stdout.match(/\n__STATUS__:(\d+)$/);
      const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
      const body = statusMatch ? stdout.slice(0, stdout.lastIndexOf('\n__STATUS__:')) : stdout;
      resolve({ status, body });
    });
  });
}

function describeConfidence(score) {
  if (score >= 85) return 'High';
  if (score >= 65) return 'Medium';
  return 'Low';
}

function scoreCandidate({ sourceKey, worked = 0, dead = 0, existingUser = true, targeted = false, hasExpiry = false, singleUse = false }) {
  let score = sourceKey.startsWith('reddit_') ? 78 : 60;
  if (existingUser) score += 10;
  if (worked > 0) score += Math.min(worked * 6, 18);
  if (dead > 0) score -= Math.min(dead * 10, 25);
  if (targeted) score -= 8;
  if (hasExpiry) score += 4;
  if (singleUse) score -= 20;
  return Math.max(5, Math.min(98, score));
}

function buildCodeEntry(code, meta) {
  const confidenceScore = scoreCandidate(meta);
  return {
    code,
    sourceKey: meta.sourceKey,
    sourceLabel: SOURCE_LABELS[meta.sourceKey] || meta.sourceKey,
    sourceUrl: meta.sourceUrl || null,
    commentUrl: meta.commentUrl || null,
    sourceTitle: meta.sourceTitle || null,
    confidenceScore,
    confidenceLabel: describeConfidence(confidenceScore),
    statusHint: meta.statusHint || 'Observed',
    statusNote: meta.statusNote || null,
    expiresAt: meta.expiresAt || null,
    region: meta.region || null,
    regionRestricted: meta.regionRestricted || false,
    regionNote: meta.regionNote || null,
    lastSeenAt: meta.lastSeenAt || new Date().toISOString(),
  };
}

function setSourceStatus(sourceKey, updates) {
  state.setSourceStatus(sourceKey, {
    label: SOURCE_LABELS[sourceKey] || sourceKey,
    ...updates,
    lastCheckedAt: new Date().toISOString(),
  });
}

// Queue codes for every active account. Per account, a code it applied in the
// last REAPPLY_SKIP_DAYS is skipped (trying again only gets "you already
// applied this promotion"), and codes it already has queued or tried are left
// alone. Returns how many distinct codes were newly queued anywhere, and
// which codes every account skipped as already applied.
function queueForAccounts(entries) {
  const queued = new Set();
  const skippedEverywhere = new Set(entries.map(e => e.code));
  for (const s of stores.active()) {
    const recent = s.getRecentlyApplied();
    const eligible = entries.filter(e => !recent.has(e.code));
    for (const e of eligible) skippedEverywhere.delete(e.code);
    const before = new Set(s.getQueue());
    if (eligible.length && s.addToQueue(eligible)) {
      for (const c of s.getQueue()) if (!before.has(c)) queued.add(c);
    }
  }
  return { queued: queued.size, skippedEverywhere };
}

// ── Thread detection ─────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A monthly promo thread's slug looks like
// "monthly_existing_user_promo_code_thread_july_2026". When we parse a listing
// page (no search query to constrain results) we require the stronger match so
// we don't pick up unrelated "monthly …" threads; on the search page the query
// already constrains results, so a plain "monthly" match is enough there.
function isMonthlyPromoSlug(slug) {
  return slug.includes('monthly') && (slug.includes('promo') || slug.includes('existing'));
}

// Pull monthly-thread links out of an old.reddit HTML page, in document order
// (the caller arranges the source so that order is newest-first).
function parseThreadEntries(body, subreddit, strict) {
  const hrefRe = new RegExp(`href="(?:https?:\\/\\/[^"]*)?\\/r\\/${subreddit}\\/comments\\/([a-z0-9]+)\\/([^"?#]+)`, 'g');
  const seen = new Set();
  const entries = [];
  let m;
  while ((m = hrefRe.exec(body)) !== null) {
    const [, id, slug] = m;
    const matches = strict ? isMonthlyPromoSlug(slug) : slug.includes('monthly');
    if (seen.has(id) || !matches) continue;
    seen.add(id);
    entries.push({ id, slug, title: 'Monthly Existing User Promo Code Thread', published: Date.now() - entries.length * 1000 });
  }
  return entries;
}

// Fallback when search comes up empty: read the subreddit listing directly. The
// monthly thread is stickied on the front page and shows up in /new/ the moment
// it's posted — neither depends on Reddit's search index, which can lag a
// freshly-posted thread by minutes to hours (most likely right at month rollover).
async function detectFromListing(subreddit) {
  const urls = [
    `https://old.reddit.com/r/${subreddit}/`,      // stickied monthly thread sits at the top
    `https://old.reddit.com/r/${subreddit}/new/`,  // newest posts, caught before search indexes
  ];
  const seen = new Set();
  const entries = [];
  for (const url of urls) {
    let status, body;
    try { ({ status, body } = await fetchUrl(url)); } catch { continue; }
    if (status !== 200) continue;
    for (const e of parseThreadEntries(body, subreddit, true)) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      entries.push(e);
    }
    if (entries.length) break; // the front page already has the stickied thread
  }
  return entries;
}

// Find the current + previous monthly promo thread for a subreddit via the
// old.reddit.com HTML search (the reddit.com search.rss endpoint 429s for busy
// subs). old.reddit occasionally returns a 200 page that's rate-limited/empty
// with no results — a transient blip — so we retry a few times, then fall back
// to the subreddit listing before giving up.
async function detectThread(subreddit) {
  const url = `https://old.reddit.com/r/${subreddit}/search?q=Monthly+Existing+User+Promo+Code+Thread&restrict_sr=1&sort=new&t=year`;
  let lastErr = `no thread found for r/${subreddit}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1500 * attempt);
    const { status, body } = await fetchUrl(url);
    if (status !== 200) { lastErr = `r/${subreddit} thread search returned ${status}`; continue; }

    // Results are sorted newest-first by ?sort=new, so preserve that order.
    const entries = parseThreadEntries(body, subreddit, false);
    if (entries.length) return entries.slice(0, 2);
    lastErr = `No r/${subreddit} thread in search results (rate-limited/empty page)`;
  }

  // Search empty/failing — try the listing (doesn't rely on the search index).
  const listing = await detectFromListing(subreddit);
  if (listing.length) return listing.slice(0, 2);

  // Both curl paths blind (Reddit's logged-out gate now covers search and
  // listing pages too, serving 200-status shells with no links) — read the
  // subreddit front page through our own Chrome, where the monthly thread is
  // stickied at the top. Sort by post id (base36, increases over time) so
  // entries[0] is the newest monthly thread regardless of page order.
  try {
    // Search first — the monthly thread isn't always pinned/hot (October
    // 2026's r/UberEATS thread never reached the front page) — then the front
    // page, which catches a pinned thread search hasn't indexed yet. Either
    // read can fail without sinking the other.
    const posts = [];
    for (const [what, read] of [
      ['search', () => reads.fetchSubredditSearch(subreddit, 'Monthly Existing User Promo Code Thread')],
      ['front page', () => reads.fetchSubredditPosts(subreddit)],
    ]) {
      try { posts.push(...((await read()) || [])); }
      catch (err) { state.appendLog({ type: 'thread_detect_browser', subreddit, via: what, error: err.message.slice(0, 100) }); }
    }
    const linkRe = new RegExp(`^/r/${subreddit}/comments/([a-z0-9]+)/([^/]+)`, 'i');
    const seen = new Set();
    const entries = [];
    for (const p of posts) {
      const m = (p.permalink || '').match(linkRe);
      if (!m) continue;
      const [, id, slug] = m;
      if (seen.has(id) || !isMonthlyPromoSlug(slug)) continue;
      seen.add(id);
      entries.push({ id, slug, title: p.title || 'Monthly Existing User Promo Code Thread', published: 0 });
    }
    entries.sort((a, b) => parseInt(b.id, 36) - parseInt(a.id, 36));
    entries.forEach((e, i) => { e.published = Date.now() - i * 1000; });
    if (entries.length) {
      state.appendLog({ type: 'thread_detect_browser', subreddit, found: entries.length, newest: entries[0].id });
      return entries.slice(0, 2);
    }
  } catch (err) {
    state.appendLog({ type: 'thread_detect_browser', subreddit, error: err.message.slice(0, 100) });
  }

  throw new Error(lastErr);
}

// Reddit post ids are base36 and grow over time.
function isNewerThread(id, than) {
  if (!than) return true;
  return parseInt(id, 36) > parseInt(than, 36);
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

// The month a thread is FOR, from its slug or title ("…_thread_november_2026"),
// so a thread posted a day early is filed under the right month. Falls back to
// the current local month.
function threadMonth(entry, now = new Date()) {
  const text = `${entry.slug || ''} ${entry.title || ''}`.toLowerCase();
  const m = text.match(new RegExp(`(${MONTHS.join('|')})[\\s_-]+(20\\d{2})`));
  if (m) return `${m[2]}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, '0')}`;
  return monthKey(now);
}

async function detectCurrentThread() { return detectThread('postmates'); }
async function detectUberEatsThread() { return detectThread('UberEATS'); }

async function fetchComments(threadId, subreddit = 'postmates', maxPages = 5) {
  const allComments = [];
  let url = `https://old.reddit.com/r/${subreddit}/comments/${threadId}/monthly_existing_user_promo_code_thread/?limit=500`;
  const cheerio = getCheerio();

  for (let page = 0; page < maxPages; page++) {
    const { status, body } = await fetchUrl(url);
    if (status !== 200) break;

    const $ = cheerio.load(body);
    $('.usertext-body .md').each((_, el) => {
      const thing = $(el).closest('[data-type]');
      if (!thing.length) return;
      const author = (thing.attr('data-author') || '').toLowerCase();
      if (author === 'automoderator') return;
      const thingClass = thing.attr('class') || '';
      if (thingClass.includes('moderator') || thingClass.includes('distinguished')) return;
      const text = $(el).text().trim();
      if (text && text.length > 3) {
        const permalink = thing.attr('data-permalink');
        allComments.push({ text, permalink: permalink ? `https://www.reddit.com${permalink}` : null });
      }
    });

    const nextLink = $('span.next-button a').attr('href');
    if (!nextLink) break;
    url = nextLink;
  }

  return allComments;
}

// Subreddits whose comments are currently unreadable. There is one banner
// slot, so it names every blocked subreddit and clears only when none are
// left. In memory on purpose: after a restart the set is empty, so the first
// healthy scan retires any stale block banner left in health.json.
const blockedSubs = new Set();

function syncBlockedBanner() {
  const existing = state.getHealthWarning();
  if (blockedSubs.size) {
    if (!existing || existing.source === 'reddit_blocked') {
      const names = [...blockedSubs].map(s => `r/${s}`).join(' & ');
      const msg = `${names} comments are unreadable (Reddit is blocking both fetch paths) — new codes are being missed.`;
      if (!existing || existing.message !== msg) state.setHealthWarning(msg, 'reddit_blocked');
    }
  } else if (existing && existing.source === 'reddit_blocked') {
    state.clearHealthWarning();
  }
}

async function scanSubreddit({ sourceKey, detectFn, getThreadId, getTriedState, saveTriedState, monthlyReset, subreddit, label, onProgress }) {

  onProgress?.({ source: label, step: 'detecting' });
  setSourceStatus(sourceKey, { status: 'checking', note: 'Looking for the latest monthly thread' });

  const storedThreadId = getThreadId();
  let entries;
  try {
    entries = await detectFn();
  } catch (err) {
    // Detection can blip transiently (old.reddit returns a rate-limited/empty
    // search page). If we already know this month's thread, fall back to it so
    // one blip doesn't break the scan or flip the source to a 30-min "error" —
    // the next successful detection still catches a genuine new monthly thread.
    if (storedThreadId) {
      state.appendLog({ type: 'reddit_check_fallback', source: label, reason: err.message, used_thread: storedThreadId });
      entries = [{ id: storedThreadId, title: 'Monthly Existing User Promo Code Thread', published: Date.now() }];
    } else {
      onProgress?.({ source: label, step: 'error', message: err.message });
      setSourceStatus(sourceKey, { status: 'error', note: err.message, usableCodes: 0 });
      return { error: `${label} thread detection failed: ${err.message}` };
    }
  }

  let newestEntry = entries[0];

  if (newestEntry.id !== storedThreadId) {
    if (isNewerThread(newestEntry.id, storedThreadId)) {
      const month = threadMonth(newestEntry);
      state.appendLog({ type: 'new_thread_detected', source: label, old_thread: storedThreadId, new_thread: newestEntry.id, month });
      monthlyReset(storedThreadId, newestEntry.id, month);
      onProgress?.({ source: label, step: 'new_thread', threadId: newestEntry.id });
    } else {
      // Detection surfaced an OLDER thread (a lagging search index, last
      // month's post still pinned). Resetting to it would archive this
      // month's results and re-queue expired codes — keep the newer one.
      state.appendLog({ type: 'thread_detect_older', source: label, detected: newestEntry.id, kept: storedThreadId });
      newestEntry = { id: storedThreadId, title: 'Monthly Existing User Promo Code Thread' };
    }
  }

  onProgress?.({ source: label, step: 'fetching', threadId: newestEntry.id });

  let comments = [];
  try {
    comments = await fetchComments(newestEntry.id, subreddit);
  } catch (err) {
    onProgress?.({ source: label, step: 'error', message: err.message });
    setSourceStatus(sourceKey, { status: 'error', note: err.message, usableCodes: 0, sourceUrl: `https://www.reddit.com/r/${subreddit}/comments/${newestEntry.id}/` });
    return { error: `${label} comment fetch failed: ${err.message}` };
  }

  // Reddit gates thread pages for plain HTTP clients (login redirect) while
  // serving search pages normally — so curl reads an empty shell and the scan
  // would "succeed" with 0 comments. Read the thread through our own Chrome
  // instead (a rendered logged-out browser still gets the page).
  const triedState = getTriedState();
  const triedSet = new Set(triedState.tried_codes);

  if (comments.length === 0) {
    // A thread that has already produced codes reading empty is almost always
    // a transient page-load blip, not a real block — all four watchdog alarms
    // on Sep 25–26 were isolated reads that recovered on the next scan. So for
    // such threads, re-read once (after a pause) before concluding anything.
    const attempts = triedSet.size > 0 ? 2 : 1;
    for (let attempt = 0; attempt < attempts && comments.length === 0; attempt++) {
      if (attempt > 0) await sleep(5000);
      try {
        const viaBrowser = await reads.fetchRedditComments(newestEntry.id, subreddit);
        if (viaBrowser === null) {
          // A login window owns the browser: this read was skipped, not blocked.
          state.appendLog({ type: 'reddit_fetch_browser', source: label, note: 'skipped — a login window is open' });
          setSourceStatus(sourceKey, { status: 'ok', note: 'Skipped this scan — a login window is open', sourceUrl: `https://www.reddit.com/r/${subreddit}/comments/${newestEntry.id}/` });
          onProgress?.({ source: label, step: 'skipped', message: 'login window open' });
          return { threadId: newestEntry.id, skipped: true, commentsScanned: 0, codesFound: 0, newCodes: 0, queued: 0 };
        }
        if (viaBrowser.length) {
          state.appendLog({ type: 'reddit_fetch_browser', source: label, comments: viaBrowser.length, ...(attempt > 0 ? { note: 'recovered on re-read' } : {}) });
          comments = viaBrowser;
        }
      } catch (err) {
        state.appendLog({ type: 'reddit_fetch_browser', source: label, error: err.message.slice(0, 120) });
      }
    }
  }

  if (reads.scanCancelled()) return { threadId: newestEntry.id, error: `${label} scan cancelled (overran its deadline)` };

  // NOTE: we intentionally do NOT fall back to the previous month's thread when
  // the newest thread is empty. Monthly codes expire when the month flips, so
  // backfilling last month's thread at rollover just re-queues a pile of expired
  // codes into the new month (they all come back "Code expired" and waste apply
  // attempts). A freshly-posted, still-empty thread simply yields no codes yet —
  // we wait for real ones to be posted rather than reintroducing stale ones.

  const codeContext = extractCodesWithContext(comments);
  const allCodes = new Set(codeContext.keys());

  // Backfill the comment deep-link onto every code seen in the thread — even
  // already-tried ones — so existing results gain a link, not just new codes.
  for (const [code, ctx] of codeContext) {
    if (ctx.commentUrl) state.mergeCodeMeta(code, { commentUrl: ctx.commentUrl });
  }

  // Silent-failure watchdog: a thread that has already produced codes suddenly
  // reading ZERO comments (even after a re-read) is Reddit blocking us, not an
  // empty thread — say so loudly (source error + banner) instead of reporting a
  // healthy no-op scan. (This exact mode went unnoticed for 9 days in July.)
  if (comments.length === 0 && triedSet.size > 0) {
    const note = 'Thread returned no comments — Reddit is likely gating the fetch (both curl and browser paths failed)';
    setSourceStatus(sourceKey, { status: 'error', note, usableCodes: 0, sourceUrl: `https://www.reddit.com/r/${subreddit}/comments/${newestEntry.id}/` });
    state.appendLog({ type: 'reddit_empty_thread_anomaly', source: label, thread_id: newestEntry.id });
    blockedSubs.add(subreddit);
    syncBlockedBanner();
    onProgress?.({ source: label, step: 'error', message: note });
    return { threadId: newestEntry.id, commentsScanned: 0, codesFound: 0, newCodes: 0, queued: 0 };
  }
  // Comments flowing — this subreddit is no longer blocked. (Tracked per
  // subreddit: a healthy r/UberEATS read used to clear an r/postmates block
  // banner, since both scans run back to back.)
  if (comments.length > 0) {
    blockedSubs.delete(subreddit);
    syncBlockedBanner();
  }

  const candidates = [...allCodes].filter(c => !triedSet.has(c)).sort();

  const sourceUrl = `https://www.reddit.com/r/${subreddit}/comments/${newestEntry.id}/`;
  const entriesToQueue = candidates.map(code => {
    const ctx = codeContext.get(code) || {};
    // Read the comment(s) this code appeared in for a region restriction.
    const region = detectRegionRestriction(ctx.context);
    return buildCodeEntry(code, {
      sourceKey,
      sourceUrl,
      // Deep link to the exact comment this code came from (falls back to the
      // thread URL in the UI when not available, e.g. older entries).
      commentUrl: ctx.commentUrl || null,
      sourceTitle: newestEntry.title,
      statusHint: 'Monthly thread',
      statusNote: `${comments.length} comments scanned in the latest monthly thread`,
      lastSeenAt: new Date().toISOString(),
      worked: 1,
      existingUser: true,
      hasExpiry: false,
      region: region ? region.region : null,
      regionRestricted: region ? region.restricted : false,
      regionNote: region ? region.note : null,
    });
  });

  // Codes already sitting on an account (applied within ~2 weeks) are skipped
  // for that account. After the monthly reset, last cycle's wins would
  // otherwise be re-queued and burn an apply slot on "Oops, you already
  // applied this promotion". A code every account skipped is NOT marked as
  // seen, so once the window passes it becomes eligible again.
  const { queued: added, skippedEverywhere } = queueForAccounts(entriesToQueue);
  const newCodes = candidates.filter(c => !skippedEverywhere.has(c));
  const alreadyNoted = new Set(triedState.skipped_applied || []);
  const newlySkipped = [...skippedEverywhere].filter(c => !alreadyNoted.has(c));
  if (newlySkipped.length) {
    state.appendLog({
      type: 'applied_skip', source: label, codes: newlySkipped,
      note: `already on the account (applied < ${cfg.REAPPLY_SKIP_DAYS}d ago)`,
    });
  }
  triedState.skipped_applied = [...new Set([...alreadyNoted, ...skippedEverywhere])];
  triedState.thread_id = newestEntry.id;
  triedState.tried_codes = [...new Set([...triedSet, ...newCodes])];
  saveTriedState(triedState);

  setSourceStatus(sourceKey, {
    status: 'ok',
    note: `${comments.length} comments scanned`,
    usableCodes: newCodes.length,
    queued: added,
    sourceUrl,
  });

  state.appendLog({ type: 'reddit_check_done', source: label, thread_id: newestEntry.id, comments_scanned: comments.length, codes_found: allCodes.size, new_codes: newCodes.length, queued: added });
  onProgress?.({ source: label, step: 'done', threadId: newestEntry.id, commentsScanned: comments.length, newCodes: newCodes.length, queued: added });

  return { threadId: newestEntry.id, commentsScanned: comments.length, codesFound: allCodes.size, newCodes: newCodes.length, queued: added };
}

// ── USCardForum ──────────────────────────────────────────────────────────────
// "UberEATs/Postmates Coupon Codes" — one long-running Discourse topic (since
// 2020, mixed English/Chinese, new codes most days). It regularly carries codes
// that never reach the Reddit threads. No monthly rollover: a high-water mark
// (newest post id scanned) means each scan reads only posts it hasn't seen.

// Pure: which post ids to read this scan. Post ids grow over time; the state
// keeps the newest id already covered (lastSeenId) and `pending`, older unseen
// ids still owed a read after a burst. The newest unseen posts always go first
// (fresh codes are the time-sensitive ones); leftover budget reads the newest
// pending ones. On a first run, or a backlog too long to catch up on (codes
// that old are dead anyway), older posts are skipped and counted.
function planUSCFRead({ stream, lastSeenId = 0, pending = [], maxPosts = cfg.USCF_POSTS_PER_SCAN, backlogLimit = cfg.USCF_BACKLOG_LIMIT }) {
  const newestId = stream.reduce((m, id) => Math.max(m, id), lastSeenId);
  const inStream = new Set(stream);
  const unseen = stream.filter(id => id > lastSeenId);
  let waiting = pending.filter(id => inStream.has(id) && id <= lastSeenId); // deleted posts drop out
  const firstRun = lastSeenId === 0;
  if (firstRun || unseen.length + waiting.length > backlogLimit) {
    const ids = unseen.slice(-maxPosts);
    return { ids, fromPending: [], pending: [], skipped: unseen.length - ids.length + waiting.length, lastSeenId: newestId, firstRun };
  }
  const newest = unseen.slice(-maxPosts);
  waiting = [...waiting, ...unseen.slice(0, unseen.length - newest.length)];
  const budget = maxPosts - newest.length;
  const fromPending = budget > 0 ? waiting.slice(-budget) : [];
  waiting = waiting.slice(0, waiting.length - fromPending.length);
  return { ids: [...fromPending, ...newest], fromPending, pending: waiting, skipped: 0, lastSeenId: newestId, firstRun };
}

// Pure: which fetched posts are worth scanning — ones this read asked for, not
// deleted/hidden, and recent enough that the code may still work.
function selectUSCFPosts(posts, wanted = null, now = Date.now(), maxAgeDays = cfg.USCF_MAX_AGE_DAYS) {
  const cutoff = now - maxAgeDays * 86400000;
  return (posts || [])
    .filter(p => p && (!wanted || wanted.has(p.id)) && !p.deleted && p.text)
    .filter(p => { const t = new Date(p.createdAt).getTime(); return !isNaN(t) && t >= cutoff; })
    .sort((a, b) => a.postNumber - b.postNumber);
}

async function scanUSCF({ onProgress } = {}) {
  const sourceKey = 'uscf';
  const label = SOURCE_LABELS.uscf;
  const topicUrl = `${cfg.USCF_BASE_URL}/t/topic/${cfg.USCF_TOPIC_ID}`;
  onProgress?.({ source: label, step: 'fetching', threadId: `topic ${cfg.USCF_TOPIC_ID}` });
  setSourceStatus(sourceKey, { status: 'checking', note: 'Reading the newest forum posts', sourceUrl: topicUrl });

  const st = state.getUSCFState();
  const lastSeenId = st.lastSeenId || 0;
  const pendingBefore = Array.isArray(st.pendingIds) ? st.pendingIds : [];
  const fail = (note) => {
    setSourceStatus(sourceKey, { status: 'error', note, usableCodes: 0, sourceUrl: topicUrl });
    state.appendLog({ type: 'forum_check_error', source: label, error: note });
    onProgress?.({ source: label, step: 'error', message: note });
    return { error: note };
  };

  let res;
  try {
    res = await reads.fetchUSCFPosts({
      topicId: cfg.USCF_TOPIC_ID, baseUrl: cfg.USCF_BASE_URL,
      plan: (stream) => planUSCFRead({ stream, lastSeenId, pending: pendingBefore }),
    });
  } catch (err) {
    return fail(`Forum fetch failed: ${err.message.slice(0, 100)}`);
  }
  if (!res) {
    // Browser held by a login window — the high-water mark is untouched, so
    // nothing is lost; the next scan picks these posts up.
    setSourceStatus(sourceKey, { status: 'ok', note: 'Skipped this scan — browser busy with a login', sourceUrl: topicUrl });
    return { skipped: true, commentsScanned: 0, codesFound: 0, newCodes: 0, queued: 0 };
  }
  // A 5,000+ post topic answering with nothing means we're being blocked —
  // say so loudly rather than report a healthy scan of zero posts.
  if (!res.streamLength) return fail('Forum topic returned no posts — the forum may be blocking the browser');
  const plan = res.plan;
  let pending = plan.pending;
  if (plan.skipped > 0) {
    state.appendLog({
      type: 'forum_backlog_skipped', source: label, skipped: plan.skipped,
      note: plan.firstRun ? 'first scan — starting from the newest posts' : `more than ${cfg.USCF_BACKLOG_LIMIT} unseen posts — skipped to the newest`,
    });
  }
  // Catching up: once the newest backlog posts read are already too old to
  // matter, everything older is too — stop owing them a read.
  const cutoff = Date.now() - cfg.USCF_MAX_AGE_DAYS * 86400000;
  const backfilled = res.posts.filter(p => plan.fromPending.includes(p.id));
  if (pending.length && backfilled.length && backfilled.every(p => new Date(p.createdAt).getTime() < cutoff)) {
    state.appendLog({ type: 'forum_backlog_skipped', source: label, skipped: pending.length, note: `older than ${cfg.USCF_MAX_AGE_DAYS} days` });
    pending = [];
  }

  const posts = selectUSCFPosts(res.posts, new Set(plan.ids));
  const comments = posts.map(p => ({ text: p.text, permalink: `${topicUrl}/${p.postNumber}` }));
  const codeContext = extractCodesWithContext(comments);
  const found = [...codeContext.keys()];

  const nowIso = new Date().toISOString();
  const entries = found.sort().map(code => {
    const ctx = codeContext.get(code) || {};
    const region = detectRegionRestriction(ctx.context);
    return buildCodeEntry(code, {
      sourceKey,
      sourceUrl: topicUrl,
      commentUrl: ctx.commentUrl || null, // deep link to the exact forum post
      sourceTitle: 'UberEATs/Postmates Coupon Codes',
      statusHint: 'Forum post',
      statusNote: `${posts.length} new post${posts.length === 1 ? '' : 's'} scanned on USCardForum`,
      lastSeenAt: nowIso,
      existingUser: true,
      region: region ? region.region : null,
      regionRestricted: region ? region.restricted : false,
      regionNote: region ? region.note : null,
    });
  });
  // Same skips as Reddit, per account: codes applied in the last 14 days, and
  // anything already queued or tried this cycle — the forum often reposts
  // codes the Reddit threads carried first, and those keep their attribution.
  const { queued: added, skippedEverywhere } = entries.length ? queueForAccounts(entries) : { queued: 0, skippedEverywhere: new Set() };
  if (skippedEverywhere.size) {
    state.appendLog({ type: 'applied_skip', source: label, codes: [...skippedEverywhere], note: `already on the account (applied < ${cfg.REAPPLY_SKIP_DAYS}d ago)` });
  }

  // Every post this read covered — including old, deleted and codeless ones —
  // is done; older unseen posts stay pending for the next scans.
  state.saveUSCFState({
    lastSeenId: plan.lastSeenId,
    pendingIds: pending,
    lastPostNumber: res.highestPostNumber || st.lastPostNumber || null, // for the dashboard's "latest post" link
    lastScanAt: nowIso,
  });

  setSourceStatus(sourceKey, {
    status: 'ok',
    note: (posts.length ? `${posts.length} new post${posts.length === 1 ? '' : 's'} scanned` : 'No new posts since last scan')
      + (pending.length ? ` · ${pending.length} older post${pending.length === 1 ? '' : 's'} next scan` : ''),
    usableCodes: added,
    queued: added,
    sourceUrl: topicUrl,
  });
  state.appendLog({ type: 'forum_check_done', source: label, posts_scanned: posts.length, codes_found: found.length, new_codes: added, queued: added, ...(pending.length ? { pending: pending.length } : {}) });
  onProgress?.({ source: label, step: 'done', commentsScanned: posts.length, newCodes: added, queued: added });
  return { threadId: `topic ${cfg.USCF_TOPIC_ID}`, commentsScanned: posts.length, codesFound: found.length, newCodes: added, queued: added };
}

// Monthly threads are usually posted on the 1st, but a 1–2 day delay is normal,
// so we don't warn until a few days in (cfg.STALE_THREAD_GRACE_DAYS). Past
// that, if we're still pointed at a previous month's thread, the new thread
// likely wasn't detected (e.g. the mods changed the title format) — surface that
// as a dashboard banner instead of silently scanning last month's thread forever.
function checkThreadStaleness(now = new Date()) {
  // Local calendar for both the day and the month — the same clock the stored
  // thread month is written in.
  const day = now.getDate();
  const currentMonth = monthKey(now);

  const stale = [];
  // A 1–2 day late post is normal, so only treat "still on last month" as a
  // problem once we're past the grace window.
  if (day >= cfg.STALE_THREAD_GRACE_DAYS) {
    const pmMonth = state.getThreadMonth();
    const ueMonth = state.getUEThreadMonth();
    if (pmMonth && pmMonth < currentMonth) stale.push('r/postmates');
    if (ueMonth && ueMonth < currentMonth) stale.push('r/UberEATS');
  }

  const existing = state.getHealthWarning();
  if (stale.length) {
    state.setHealthWarning(
      `Still on last month's ${stale.join(' & ')} thread — the ${currentMonth} monthly thread hasn't been detected. ` +
      `If it's been posted, the title format may have changed; check the subreddit.`,
      'thread_stale'
    );
  } else if (existing && existing.source === 'thread_stale') {
    // Not stale (or still within grace) — always retire a leftover stale banner.
    state.clearHealthWarning();
  }
}

async function runRedditCheck({ onProgress } = {}) {
  state.appendLog({ type: 'reddit_check_start' });
  const cancelled = { error: 'Scan cancelled (overran its deadline)' };

  const pm = await scanSubreddit({
    sourceKey: 'reddit_postmates',
    detectFn: detectCurrentThread,
    getThreadId: state.getThreadId,
    getTriedState: state.getTriedState,
    saveTriedState: state.saveTriedState,
    monthlyReset: state.monthlyReset,
    subreddit: 'postmates',
    label: 'Postmates',
    onProgress,
  });

  if (reads.scanCancelled()) return cancelled;
  const ue = await scanSubreddit({
    sourceKey: 'reddit_ubereats',
    detectFn: detectUberEatsThread,
    getThreadId: state.getUEThreadId,
    getTriedState: state.getUETriedState,
    saveTriedState: state.saveUETriedState,
    monthlyReset: state.ueMonthlyReset,
    subreddit: 'UberEATS',
    label: 'UberEATS',
    onProgress,
  });

  if (reads.scanCancelled()) return cancelled;
  checkThreadStaleness();

  // USCardForum is supplementary: a failure shows as an error on its own
  // source card but doesn't fail the scan (Reddit is the primary signal and
  // drives the scan heartbeat). Its new codes DO count toward `queued`, so
  // they trigger apply-on-arrival like any other fresh code.
  let us;
  try {
    us = await scanUSCF({ onProgress });
  } catch (err) {
    us = { error: err.message };
  }
  if (reads.scanCancelled()) return cancelled;

  // Release what Playwright accumulated during this scan's page loads (the
  // cause of the Aug 20 out-of-memory crash) — skipped if an apply run, login
  // or session check is using the browser right now.
  try { await browser.recycleIfIdle(); } catch {}

  const scans = [pm, ue, us];
  const totalNew = scans.reduce((sum, entry) => sum + (entry.newCodes || 0), 0);
  const totalQueued = scans.reduce((sum, entry) => sum + (entry.queued || 0), 0);
  const coreErrors = [pm.error, ue.error].filter(Boolean);

  return {
    threadId: pm.threadId,
    ueThreadId: ue.threadId,
    commentsScanned: (pm.commentsScanned || 0) + (ue.commentsScanned || 0) + (us.commentsScanned || 0),
    newCodes: totalNew,
    queued: totalQueued,
    postmates: pm,
    ubereats: ue,
    uscf: us,
    error: coreErrors.length > 0 ? coreErrors.join('; ') : null,
  };
}

module.exports = {
  runRedditCheck,
  scanUSCF,
  selectUSCFPosts,
  planUSCFRead,
  detectCurrentThread,
  detectUberEatsThread,
  detectFromListing,
  checkThreadStaleness,
  isMonthlyPromoSlug,
  isNewerThread,
  threadMonth,
  queueForAccounts,
  fetchComments,
};
