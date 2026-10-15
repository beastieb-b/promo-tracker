// The dashboard's numbers for one account or several ("All accounts").

const cfg = require('./config');
const state = require('./state');
const { summarizeSavings } = require('./store');

function getStats(stores, now = new Date()) {
  const month = stores.flatMap(s => s.monthResults(now));
  const catalog = state.getCodeCatalog();
  const successes = month.filter(r => r.result === 'success');
  // "Already applied" successes confirm that a code from an earlier cycle is
  // still on the account — not fresh wins, so they don't count as "applied".
  const freshSuccesses = successes.filter(r => !state.isAlreadyApplied(r));
  const regionLocked = month.filter(r => r.result === 'region_skip');
  const u = state.getUSCFState();
  const recentCutoff = now.getTime() - cfg.REAPPLY_SKIP_DAYS * 86400000;
  const resets = stores.map(s => s.getLastResetDate()).filter(Boolean).sort();
  const tag = (r) => ({ account: r.account, accountName: r.accountName });

  return {
    threadId: state.getThreadId(),
    threadMonth: state.getThreadMonth(),
    ueThreadId: state.getUEThreadId(),
    ueThreadMonth: state.getUEThreadMonth(),
    threadFreshness: state.getThreadFreshness(now),
    uscf: {
      topicId: cfg.USCF_TOPIC_ID,
      url: `${cfg.USCF_BASE_URL}/t/topic/${cfg.USCF_TOPIC_ID}`,
      lastPostNumber: u.lastPostNumber || null,
      lastScanAt: u.lastScanAt || null,
    },
    // Codes inside the re-apply skip window — shown on the Queue page so
    // "why isn't X queued?" has a visible answer.
    recentlyAppliedList: stores.flatMap(s => Object.entries(s.loadAppliedLedger())
      .map(([code, ts]) => ({ code, appliedAt: ts, ms: new Date(ts).getTime(), account: s.account.id, accountName: s.account.name })))
      .filter(e => !isNaN(e.ms) && e.ms >= recentCutoff)
      .sort((a, b) => b.ms - a.ms)
      .map(({ ms, ...e }) => e),
    reapplySkipDays: cfg.REAPPLY_SKIP_DAYS,
    queueCount: stores.reduce((n, s) => n + s.getQueue().length, 0),
    totalTried: month.length,
    successCount: freshSuccesses.length,
    alreadyOnAccountCount: successes.length - freshSuccesses.length,
    rejectedCount: month.filter(r => r.result === 'rejected').length,
    rateLimitedCount: month.filter(r => r.result === 'ratelimited').length,
    regionLockedCount: regionLocked.length,
    ...summarizeSavings(stores.map(s => s.savingsBuckets()), now),
    lastResetDate: resets.length ? resets[resets.length - 1] : null,
    appVersion: require('../package.json').version,
    heartbeat: state.getHeartbeat(),
    successList: successes.map(r => ({ code: r.code, detail: r.detail, already: state.isAlreadyApplied(r), platform: r.platform, amount: r.amount, ...tag(r) })),
    regionLockedList: regionLocked.map(r => ({ code: r.code, detail: r.detail, platform: r.platform, amount: r.amount, location: r.location, ...tag(r) })),
    monitoredSources: Object.entries(catalog.sources)
      .map(([key, value]) => ({ key, ...value }))
      .sort((a, b) => (a.label || a.key).localeCompare(b.label || b.key)),
  };
}

// One line per account for the account switcher and the Accounts card.
function accountSummaries(stores, loginState, now = new Date()) {
  return stores.map(s => ({
    id: s.account.id,
    name: s.account.name,
    loggedIn: loginState(s.account, 'postmates'),
    ueLoggedIn: loginState(s.account, 'ubereats'),
    queueCount: s.getQueue().length,
    savedThisMonth: summarizeSavings([s.savingsBuckets()], now).savedThisMonth,
  }));
}

module.exports = { getStats, accountSummaries };
