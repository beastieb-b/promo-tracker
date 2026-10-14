// Source reads through the app's own Chrome. Reddit gates plain HTTP clients
// (thread pages since Jul 2026, search/listing pages since Aug 2026) and the
// forum is Cloudflare-gated, but a real rendered browser — logged out, no
// accounts needed — still gets every page. Each read runs on its own page
// under a hard deadline (browser.withPage) and steps aside while a login
// window owns the browser.

const { AsyncLocalStorage } = require('async_hooks');
const browser = require('./browser');

const loginOpen = () => browser.holder() === 'login';

// A scan runs inside its own context. When it overruns its deadline the
// daemon cancels it: every later read from that scan fails at once, so a
// stale scan can't keep reading (and writing) alongside the next one.
const scanContext = new AsyncLocalStorage();

function runScan(fn) {
  const ctx = { cancelled: false };
  return { ctx, promise: scanContext.run(ctx, fn) };
}

function scanCancelled() {
  return !!scanContext.getStore()?.cancelled;
}

function withPage(label, ms, work) {
  if (scanCancelled()) return Promise.reject(new Error('Scan cancelled (it overran its deadline)'));
  return browser.withPage(label, ms, work);
}

// Reddit's logged-out gate expanded to search/listing pages (Aug 2026): curl
// now gets 200-status shells with no post links, so thread DETECTION went
// blind the same way comment fetching did in July. Same cure: read the
// subreddit front page through our own Chrome (logged out — no Reddit account
// needed) and let the caller pick out the monthly-thread posts.
async function fetchSubredditPosts(subreddit) {
  if (loginOpen()) return [];
  return withPage('Reddit front-page read', 60000, async (page) => {
    await page.goto(`https://www.reddit.com/r/${subreddit}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);
    return await page.evaluate(() =>
      [...document.querySelectorAll('shreddit-post')].map(p => ({
        title: p.getAttribute('post-title') || '',
        permalink: p.getAttribute('permalink') || '',
      }))
    );
  });
}

// Reddit's own search, read through the browser. The monthly thread isn't
// always pinned or "hot" — October 2026's r/UberEATS thread never appeared on
// the front page, so front-page detection couldn't see it — but it always
// shows up in a newest-first search.
async function fetchSubredditSearch(subreddit, query) {
  if (loginOpen()) return [];
  return withPage('Reddit search', 60000, async (page) => {
    const q = encodeURIComponent(query);
    await page.goto(`https://www.reddit.com/r/${subreddit}/search/?q=${q}&restrict_sr=1&sort=new&t=month`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);
    return await page.evaluate(() =>
      [...document.querySelectorAll('a[href*="/comments/"]')].map(a => ({
        title: (a.innerText || '').trim(),
        permalink: a.getAttribute('href') || '',
      }))
    );
  });
}

// ── USCardForum (Discourse) fetch via the browser ───────────────────────────
// The "UberEATs/Postmates Coupon Codes" topic is Cloudflare-gated for plain
// HTTP clients (403), but the forum's own JSON API answers normally from inside
// a page on its origin. Load the topic once to establish that origin, read the
// topic's post stream (every post id, in order), let `plan(stream)` pick which
// post ids to read, then fetch those via /t/{id}/posts.json.
async function fetchUSCFPosts({ topicId, baseUrl, plan }) {
  if (loginOpen()) return null; // never fight the login window for the browser
  return withPage('USCardForum read', 90000, async (page) => {
    await page.goto(`${baseUrl}/t/topic/${topicId}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(3000);
    const getJson = (url) => page.evaluate(async (u) => {
      const r = await fetch(u, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${u}`);
      return r.json();
    }, url);

    const topic = await getJson(`/t/${topicId}.json`);
    const stream = (topic.post_stream && topic.post_stream.stream) || [];
    const chosen = plan(stream);

    const raw = [];
    for (let i = 0; i < chosen.ids.length; i += 20) {
      const qs = chosen.ids.slice(i, i + 20).map(id => `post_ids[]=${id}`).join('&');
      const d = await getJson(`/t/${topicId}/posts.json?${qs}`);
      raw.push(...((d.post_stream && d.post_stream.posts) || []));
    }

    // Cooked HTML → text that keeps line boundaries (so "CODE1</p><p>CODE2"
    // can't fuse into one token), minus quoted earlier posts. DOMParser builds
    // an inert document: no scripts run, no images load.
    const posts = await page.evaluate((list) => list.map(p => {
      const el = new DOMParser().parseFromString(`<div>${p.cooked || ''}</div>`, 'text/html').body;
      el.querySelectorAll('aside.quote').forEach(q => q.remove());
      el.querySelectorAll('br').forEach(b => b.replaceWith('\n'));
      el.querySelectorAll('p, div, li, pre, tr, h1, h2, h3, h4, h5, h6').forEach(b => b.append('\n'));
      return {
        id: p.id,
        postNumber: p.post_number,
        createdAt: p.created_at,
        deleted: !!(p.deleted_at || p.user_deleted || p.hidden || p.cooked_hidden),
        text: (el.textContent || '').replace(/\n{3,}/g, '\n\n').trim(),
      };
    }), raw.map(p => ({ id: p.id, post_number: p.post_number, created_at: p.created_at, cooked: p.cooked,
      deleted_at: p.deleted_at, user_deleted: p.user_deleted, hidden: p.hidden, cooked_hidden: p.cooked_hidden })));

    return { streamLength: stream.length, highestPostNumber: topic.highest_post_number || null, plan: chosen, posts };
  });
}

// ── Reddit comment fetch via the browser ────────────────────────────────────
// On 2026-07-20 Reddit started requiring a login for thread pages fetched by
// plain HTTP clients (302 → /login?reason=lor2): old.reddit HTML, .json and
// .rss all bounce to a login gate, while SEARCH pages still work anonymously —
// so thread detection kept succeeding while comment fetches silently read
// nothing. A real rendered browser still gets the new-Reddit page logged out,
// so when curl comes back empty the scanner reads the thread through our own
// Chrome instead. No Reddit account or cookie is needed for this.
async function fetchRedditComments(threadId, subreddit) {
  if (loginOpen()) return null; // never fight the login window for the browser
  return withPage('Reddit comment read', 150000, async (page) => {
    await page.goto(`https://www.reddit.com/r/${subreddit}/comments/${threadId}/?limit=500`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    // The new frontend lazy-loads comments in batches behind "View more
    // comments" buttons — scrolling alone tops out around 25 comments on long
    // threads (a thread measured 92 when clicked through). Click load-more
    // when present, otherwise scroll, until the count stabilizes twice.
    let prev = -1;
    let stable = 0;
    for (let i = 0; i < 15 && stable < 2; i++) {
      const more = page.getByRole('button', { name: /view more comments|more replies|load more/i }).first();
      if (await more.isVisible({ timeout: 500 }).catch(() => false)) {
        await more.click().catch(() => {});
        await page.waitForTimeout(1500);
      } else {
        await page.mouse.wheel(0, 6000).catch(() => {});
        await page.waitForTimeout(1000);
      }
      const n = await page.locator('shreddit-comment').count().catch(() => 0);
      stable = n === prev ? stable + 1 : 0;
      prev = n;
    }

    const comments = await page.evaluate(() => {
      return [...document.querySelectorAll('shreddit-comment')].map(el => {
        // querySelector returns the element's OWN body: in document order it
        // precedes any nested reply's slot, so replies don't duplicate parents.
        const body = el.querySelector('[slot="comment"]');
        return {
          author: (el.getAttribute('author') || '').toLowerCase(),
          distinguished: el.getAttribute('distinguished') || null,
          text: (body ? body.innerText : '').trim(),
          permalink: el.getAttribute('permalink'),
        };
      });
    });

    // Same exclusions as the old.reddit parser: AutoModerator + mod posts.
    return comments
      .filter(c => c.author !== 'automoderator' && !c.distinguished && c.text && c.text.length > 3)
      .map(c => ({ text: c.text, permalink: c.permalink ? `https://www.reddit.com${c.permalink}` : null }));
  });
}

module.exports = {
  fetchSubredditPosts, fetchSubredditSearch, fetchUSCFPosts, fetchRedditComments,
  runScan, scanCancelled, loginOpen,
};
