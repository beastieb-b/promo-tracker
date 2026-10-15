# 🍔 Promo Tracker

Automatically finds **existing-user** promo codes for Postmates and Uber Eats,
applies them to your account, and tracks how much you've actually saved, all
from a local web dashboard on your Mac.

It watches the monthly promo-code threads on **r/postmates** and **r/UberEATS**
plus the long-running [USCardForum coupon topic](https://www.uscardforum.com/t/topic/15780),
extracts the codes, and applies each one through a real logged-in Chrome
window. Codes Postmates rejects get a second chance on Uber Eats. Codes that
turn out to be locked to another city (e.g. "Las Vegas only") are detected and
**left out of your savings total**, so the number stays honest.

> [!WARNING]
> **Use at your own risk.** Promo Tracker is an unofficial hobby project. It is
> not affiliated with, endorsed by, or supported by Uber, Postmates, Uber Eats,
> Reddit, or USCardForum. It automates those websites on your behalf, which may
> violate their terms of service. Applying promo codes automatically can get an
> account warned, restricted, or closed, and promos you didn't qualify for may be
> reversed. Use it only with your own accounts, keep the schedule conservative
> (the defaults are), and don't hammer anyone's servers. The software comes with
> no warranty (see [LICENSE](LICENSE)).

---

## How it works

```
                 ┌──────────────────────────── daemon (launchd) ─────────────────────────────┐
  every 2 h *    │  Scan    ──▶  extract codes  ──▶  queue (priority-ordered)                  │
  every 4 h * ┐  │  Apply   ──▶  open promo box in Chrome ──▶ type + apply ──▶ read the result  │
  + on arrival┘  │                └▶ rejected on Postmates? ──▶ retry on Uber Eats              │
                 └─────────────────────────────────────────────────────────────────────────────┘
                                   ▲                                  │
                                   │  SSE + REST                      ▼
                           Dashboard (Express, :8766)        data/ (JSON + text, atomic writes)

  * defaults, adjustable in Settings
```

1. **Scan.** Finds the current monthly thread on each subreddit and reads its
   comments, plus the newest USCardForum posts.
   - Reddit gates plain HTTP clients behind a login, and the forum is behind
     Cloudflare, so reads go through the app's own Chrome (no Reddit or forum
     account needed). Reddit is tried with `curl` first because it's cheap; when
     that returns nothing, the browser reads the page.
   - **Thread detection** uses Reddit search (newest first) and the subreddit
     front page, so a new month's thread is found even when it isn't pinned. The
     app only ever moves to a *newer* thread. If a source is still on last
     month's thread a few days into a new month, the dashboard raises a banner
     instead of quietly scanning the old one.
   - **USCardForum** is one continuous topic (since 2020, English and Chinese)
     that often carries codes Reddit never gets. The app reads it through the
     forum's JSON API and remembers the newest post it has read, so each scan
     reads only new posts. After downtime it catches up oldest-first; posts
     older than 14 days are ignored.
2. **Extract.** Pulls promo-code-shaped tokens out of the text and filters out
   false positives (English words, city names, clock times like `12:00AM`,
   platform names, and so on). Each code keeps a link to the exact comment or
   post it came from.
3. **Apply.** Opens the promo box in a real Chrome window (Postmates blocks
   headless browsers), types each code, clicks Apply, and reads the result. At
   most **5 codes per run**, **2 minutes apart**, to stay clear of rate limits.
   Codes you add by hand go first, then codes containing digits, then by
   confidence and recency.
   - **Apply on arrival:** when a scan queues new codes, a run starts right away
     instead of waiting for the schedule. It is guarded: never while a run is
     active, at least 30 min after the last real run, and a 2 h backoff after
     any rate-limited run.
   - **Already on your account:** a code applied within the last **14 days**
     isn't re-queued (trying it again only returns "you already applied this
     promotion"). After 14 days it becomes eligible again.
4. **Read the result.** Only text that *appears after* clicking Apply counts,
   because the promo box always lists other promos and their amounts. The result
   is `success` (with the discount), `rejected` (with the reason), `region_skip`
   (applied but locked to another city), `ratelimited` (stops the run, keeps
   codes queued), or a transient `error` (retried next run). Sometimes the box
   just closes with no message. When that happens the app applies the code once
   more: "you already applied this promotion" proves the first try worked.
5. **Uber Eats fallback.** A code rejected on Postmates for any reason **except
   "Code expired"** is retried on **Uber Eats** (same Uber promo box). A win
   there counts toward your savings and is labeled "Uber Eats". If Uber Eats
   can't be signed into, the code is **held** and retried there automatically
   once the Uber Eats login works again.
6. **Automatic sign-in.** When a site looks logged out, the app first follows
   its **Log in** link. Usually only the site's own session has lapsed while your
   Uber account sign-in is still valid, so this signs straight back in with no
   password. The app **never types credentials**. If Uber asks for a password,
   the dashboard asks you to sign in instead.

Notifications live in the dashboard only: toasts, a live progress card, and
banners when something needs you.

---

## Requirements

- **macOS** (the background service uses `launchd`)
- **Node.js 20.18.1 or newer**
- **Google Chrome**, installed normally (Playwright drives it with `channel: 'chrome'`)
- `curl` and `sqlite3` (both come with macOS)
- A Postmates account, and optionally an Uber Eats account (same Uber login)

---

## Setup

```sh
# 1. Install dependencies (Playwright uses your installed Chrome, so skip its browser download)
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci

# 2. Log in to Postmates (opens Chrome: log in, then close the window)
npm run setup

# 3. Install the background service (starts automatically when you log in to the Mac)
npm run install-service
```

Or double-click **`Postmates Promo Tracker.command`**, which installs
dependencies if needed, starts the app, and opens the dashboard.

Then open **http://localhost:8766** and finish the Setup checklist:

- **Set your home region** (Settings → Home Region): your city, any nicknames
  for it, and your state. National promos and promos for your city or state
  count toward savings; promos locked to anywhere else are marked region-locked.
  Until it's set, every promo counts.
- **Log in to Uber Eats** (Settings → *Log in to Uber Eats*) so the rejection
  fallback can apply codes there too. It's a separate login in the same Chrome
  profile.

A login window closes by itself after 15 minutes if it's left open, so it
can't hold up the app.

---

## Multiple accounts

Settings → **Multiple accounts** lets one Mac run codes for several Uber
accounts, for example the people in your household, each with their own
account. It's off by default; turned off, the app uses only the first account.

- **Each account gets its own Chrome profile**, so each has its own Postmates
  and Uber Eats login. Add accounts and log them in from Settings → Accounts.
- **Sources are scanned once**, and every new code is queued for every account.
  Each account keeps its own queue, results, savings, and 14-day "already
  applied" list.
- **Apply runs go through the accounts one after another**, each with its own
  5-code limit. The 2-minute gap also applies between accounts, so the sites
  never see requests faster than with a single account. A rate limit stops the
  whole run; a logged-out account just sits out until it's signed in again.
- A new account starts with the codes seen in the last 14 days.
- The dashboard's account switcher shows one account or all of them together.
  Home region and schedules are shared.
- Removing an account moves its data and Chrome profile to
  `data/accounts-removed/`; nothing is erased.

> [!CAUTION]
> Uber allows one account per person. Several accounts redeeming the same
> codes from one computer and one internet connection is the kind of pattern
> fraud checks look for, and it can get accounts flagged or promos reversed.
> Use this only for people's own real accounts.

---

## Using it from your phone or another computer

By default the dashboard listens on `127.0.0.1`, so only this Mac can open it.
To use it from other devices (on your home Wi-Fi, or over a VPN such as
[Tailscale](https://tailscale.com)), create **`config.local.json`** next to
`package.json` (see `config.local.example.json`):

```json
{
  "host": "0.0.0.0",
  "allowedHosts": ["my-mac.tailnet-name.ts.net"]
}
```

Restart the app (`npm run restart`), then get the **access link**:

```sh
npm run access-link
```

You can also copy it from Settings → *Remote access* on the Mac itself. Open
the link once on each phone or laptop and that browser stays signed in for a
year. **Anyone with the link can control the app, so keep it private.** To revoke
every device, delete `data/access_token` and restart; a new link is created.

How access works:

- **This Mac** needs no link, but the address must be one of the Mac's own names
  or IPs (or listed in `allowedHosts`). That stops a malicious web page from
  reaching the dashboard through DNS rebinding.
- **Every other device** needs the access link (a long-lived, HttpOnly cookie).
- **Every change** (buttons, settings) must come from the dashboard's own page.
  Cross-site requests are refused.
- Requests that arrive through a proxy (for example `tailscale serve`) count as
  other devices.

---

## Dashboard

| Section | What it shows |
|---|---|
| **Dashboard** | Saved this calendar month (region-locked codes excluded, with the Uber Eats share called out), codes applied, queue size, successful codes, recent activity, a "Worked, but region-locked" card, **Savings by Month**, a **This Month's Thread** card (shown early in the month, or while a source hasn't rolled over), and live source health. |
| **Queue** | Codes waiting to be tried, in the exact order the next run will try them, with source and region hints. Add codes by hand (they go first). **Already on Your Account** lists codes skipped because they were applied recently. |
| **Results** | Every attempt with result, reason, platform, time, and a link to the exact Reddit comment or forum post. Per-row actions: **Retry**, **mark region-locked**, **count it**, and delete (with Undo). |
| **Activity Log** | The raw event log: scans, applies, sign-ins, skips, errors. |
| **Settings** | Login status for both sites (or, with Multiple accounts on, an **Accounts** list with each account's logins), code sources (both monthly threads plus the forum topic, each linked), the **System Health** self-test, scan and apply intervals, home region, and remote access. |

The sidebar holds **Check Sources** and **Apply Codes** (run now) plus
**Restart** and **Quit**. Under the logo is the version the server is running
and its build (git commit), e.g. `v2.1.0 · c9ac9b0`; Settings → About adds the
build date and when the server started. If newer code is on disk than what's
running (say, after a `git pull`), a **Restart to update** button appears.
`npm run version:show` prints the same from Terminal. Sections have their own addresses (`#queue`,
`#results`, …), so Back/Forward and reload work. Banners appear only when you need to act: a login the app
couldn't restore by itself, a self-test failure, a missed monthly thread, or a
source that can't be read.

---

## Configuration

**Settings page**

- **Source scan interval**: how often to check Reddit and USCardForum
  (default every 2 h; 30 min to 24 h).
- **Code apply interval**: how often to try queued codes (default every 4 h;
  1 h to 24 h). New codes are also applied on arrival (see above).
- **Home region**: city, nicknames, and state (see Setup).
- **Multiple accounts**: run codes for several Uber accounts (see above).

**`config.local.json`** (gitignored, read at startup)

| Key | Default | Meaning |
|---|---|---|
| `host` | `127.0.0.1` | Address to listen on. `0.0.0.0` allows other devices (with the access link). |
| `port` | `8766` | Dashboard port. |
| `allowedHosts` | `[]` | Extra names this Mac is reached by (e.g. a Tailscale MagicDNS name). |
| `accessToken` | generated | Fixed access token, instead of the generated one in `data/access_token`. |

Environment variables override the file: `HOST`, `PORT`, `PROMO_TOKEN`, and
`PROMO_DATA_DIR` (move all state elsewhere). Schedules follow the Mac's own
time zone; set `TZ` to override. The daily self-test runs at **4:45 AM** local
time.

---

## Region & savings logic

"Saved this month" adds up the `success` results from the current calendar
month. Percentage promos (e.g. "30% off") count as $0 because they have no
fixed value. A code becomes `region_skip` (excluded) when:

1. **The site says so.** The applied promo shows a `Location` that isn't your
   home region, your home state, or nationwide. This is the source of truth.
2. **A comment says so** (e.g. "vegas only"). This only *labels* the code in
   the queue; it never blocks the attempt, because community reports are often
   wrong.

"Already applied" confirmations count as $0 too: that code's savings were
counted when it first applied. You can override any verdict from the Results
table (mark region-locked, or count it back).

---

## npm scripts

| Command | Description |
|---|---|
| `npm start` | Run the app in the foreground. |
| `npm run setup` / `setup:ubereats` | Open Chrome to log in to Postmates / Uber Eats (add `-- --account <id>` for another account). |
| `npm run scan` | Run a one-off source scan. |
| `npm run apply` | Run a one-off apply pass. |
| `npm run access-link` | Print the links that let other devices open the dashboard. |
| `npm run install-service` / `uninstall-service` | Install or remove the `launchd` agent. |
| `npm run restart` | Reload the background service. |
| `npm test` / `npm run lint` | Unit tests (`node --test`) / ESLint. |

The one-off commands refuse to run while the app is already running, since two
copies would fight over the same Chrome profile. Use the dashboard instead.

---

## Background service & reliability

Installed as a `launchd` user agent **`com.postmates.promo`** with `RunAtLoad`
and `KeepAlive`, so it starts at login and restarts if it crashes. It does
**not** run while the Mac is asleep or off; the dashboard's staleness warning
flags that. **Quit** in the dashboard unloads the service until your next login
(or `npm run restart`); **Restart** lets `launchd` bring it straight back.

- **Deadlines everywhere.** Some browser operations have no built-in timeout
  and can wait forever on a frozen page. Every page read, code attempt,
  self-test, and session check runs under a hard deadline. An apply run never
  starts a code it couldn't finish within its time budget, and a scan that
  overruns closes only its own pages, so it can't take down an apply run that's
  sharing the browser.
- **Chrome is recycled after every scan** when nothing else is using it, and
  relaunched on next use (~2 s; logins survive because cookies live in the
  profile on disk). This keeps memory flat.
- **Daily self-test (4:45 AM).** Applies a fake code and expects a rejection,
  so a site UI change is caught within a day, and checks the Uber Eats login.
- **Housekeeping** at startup and daily: logs are trimmed (`run_log.jsonl` to
  the last 5,000 events, daemon logs to 1,000 lines) and debug screenshots older
  than 14 days are deleted.

---

## Data & state (`data/`)

All state lives in `data/` (gitignored). Full-file writes are **atomic**
(temp file + rename), so a crash or sleep can't corrupt them.

| File | Purpose |
|---|---|
| `queue.txt` | Codes waiting to be applied. |
| `processed.txt` | This cycle's results: `CODE⇥result⇥detail⇥timestamp`. |
| `code_catalog.json` | Per-code metadata (source, region, comment link, held-for-Uber-Eats flags) plus source health. |
| `tried_codes.json` / `ue_tried_codes.json` | Codes already seen in each subreddit's current thread. |
| `applied_codes.json` | Codes that landed on the account, with when (drives the 14-day skip). |
| `uscf_state.json` | The newest USCardForum post already read. |
| `thread_config.txt` / `ue_thread_config.txt` | Current monthly thread IDs. |
| `last_thread_month.txt` / `ue_last_thread_month.txt` | Which month each thread is for (drives the stale-thread banner). |
| `last_thread_detected.txt` / `ue_last_thread_detected.txt` | When each thread was first found. |
| `session_state.json` | Whether each login was last confirmed working. |
| `settings.json` | Intervals and home region. |
| `heartbeat.json` | Last successful scan/apply (for the staleness warning and apply guards). |
| `health.json` | The active warning banner, if any. |
| `access_token` | Secret behind the access link (only used with network access on). |
| `daemon.lock` | Which process is running, so a second copy refuses to start. |
| `run_log.jsonl` | Structured event log (shown in the Activity Log). |
| `daemon.log` / `daemon-error.log` | Console output from the background service. |
| `debug-screenshots/` | Screenshots taken when an apply step fails (kept 14 days). |
| `browser-profile/` | The logged-in Chrome profile. **It contains your sessions; keep it private.** |
| `accounts.json`, `accounts/<id>/` | Extra accounts (Multiple accounts): each folder has that account's queue, results, logins and Chrome profile. |
| `code_flags.json` | Per-code notes for the first account (held for Uber Eats, failure counts). |

When a newer r/postmates monthly thread appears, that cycle's results and any
codes queued before the current month are archived to `archive/`. Codes queued
this month (from r/UberEATS, the forum, or by hand) stay queued.

---

## Development

```sh
npm test         # unit + HTTP tests; they use a temporary data directory, never data/
npm run lint
node src/index.js --no-schedule   # dashboard only: no scans or applies
```

| Module | Responsibility |
|---|---|
| `src/index.js` | Entry point: CLI commands, schedules, run orchestration and deadlines, apply on arrival, daily check, housekeeping. |
| `src/server.js` | Express dashboard, SSE, REST API, security middleware. |
| `src/access.js` | Host allowlist, access token and cookie, remote-access links. |
| `src/reddit.js` | Thread detection, comment scanning, USCardForum scanning, stale-thread checks. |
| `src/reads.js` | Source reads through the browser (Reddit search/front page/threads, forum API). |
| `src/browser.js` | Chrome lifecycle, the exclusive-use lease, deadlines, page recycling. |
| `src/promo.js` | The promo box: open it, sign back in, type, apply, read the verdict, confirm. |
| `src/classify.js` | Turning the promo box's new text into a verdict. |
| `src/runner.js` | Apply runs (Uber Eats fallback, parking, budget) and the self-test. |
| `src/login.js` | Login windows and session checks. |
| `src/session.js` | Persisted "is this login working" state, per account. |
| `src/extractor.js` | Promo-code extraction and per-code comment context. |
| `src/region.js` / `src/us-states.js` | Home/region detection and savings eligibility. |
| `src/state.js` | Shared state: code catalog, monthly threads, logs, banners, monthly reset. |
| `src/store.js` | One account's queue, results, flags, 14-day ledger, archives and savings. |
| `src/accounts.js` | The account list (Multiple accounts) and where each account's files live. |
| `src/stats.js` | Dashboard numbers for one account or all of them. |
| `src/settings.js` | Settings, cron conversion, setup checklist, apply-on-arrival guard. |
| `src/config.js` | Paths, limits, timings, and `config.local.json`. |
| `src/time.js` | Local-calendar helpers. |
| `src/lock.js` | One running copy at a time. |
| `public/` | The dashboard (plain ES modules, no build step). |

---

## Troubleshooting

- **"Session expired" banner.** The app already pressed *Log in* for you and
  Uber asked for a password. Click the banner's **Log in** button, sign in in the
  Chrome window that opens on the Mac, then close it.
- **Login shows "Unverified".** Logins are confirmed by a real page visit right
  after you sign in, by the daily check, and by apply runs. It resolves on its
  own shortly after logging in.
- **Results look wrong or nothing applies.** Settings → *System Health* → *Run
  Test*. It applies a fake code and expects a rejection; a failure usually means
  the site's UI changed.
- **"Comments are unreadable" banner.** Reddit is blocking both the plain and
  the browser reads. It clears itself once reads work again. (Forum problems
  show on the USCardForum source card instead.)
- **"Scans stalled" warning.** The service isn't running, or the Mac was
  asleep. Run `npm run restart`.
- **"Access link needed" on another device.** Open the link from
  `npm run access-link` on that device once.
- **"Unknown host".** You opened the dashboard on this Mac by a name it doesn't
  know. Add that name to `allowedHosts` in `config.local.json` and restart.

---

## License

[MIT](LICENSE)
