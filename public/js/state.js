// Shared client state plus a tiny publish/subscribe hub so modules can react
// to fresh data without importing each other.

export const state = {
  meta: null,          // /api/meta (null until loaded)
  stats: null,         // /api/stats
  scanStatus: null,    // latest scanStatus (stats poll or SSE, whichever is newer)
  scanStatusAt: 0,     // when an SSE event last set scanStatus
  settings: {},        // stats.settings / POST /api/settings response
  processed: [],       // /api/processed (oldest first)
  queue: [],           // /api/queue (server order)
  queueLoaded: false,
  logs: [],            // /api/log (newest first)
  logLoaded: false,
  access: null,        // /api/access (viewer on the Mac only)
  accessError: null,

  filter: 'all',       // Results filter
  search: '',          // Results search (upper-cased)

  hidden: { processed: new Set(), queue: new Set() },   // rows waiting out their Undo window
  starting: { reddit: false, apply: false },            // run request in flight
  runsDone: { reddit: 0, apply: 0 },                    // *_done events seen (orders click vs. finish)
  login: { postmates: false, ubereats: false },         // login window being opened
  selfTest: { running: false, result: null },
  openSteps: new Set(),                                 // expanded setup steps
  lastRun: { reddit: null, apply: null },

  connection: 'connecting',
  stopped: false,      // user pressed Quit
  restarting: false,   // user pressed Restart; waiting for the server
  authRequired: false,
};

const subscribers = new Map();

export function subscribe(topic, fn) {
  if (!subscribers.has(topic)) subscribers.set(topic, new Set());
  subscribers.get(topic).add(fn);
}

export function publish(topic, payload) {
  for (const fn of subscribers.get(topic) || []) {
    try { fn(payload); } catch (err) { console.error(`[${topic}]`, err); }
  }
}
