#!/bin/bash
# Promo Tracker — double-click to launch, or run from Terminal

# ── Navigate to this script's folder (works wherever you move it) ────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Helpers ──────────────────────────────────────────────────────────────────
alert() {
  osascript -e "display dialog \"$1\" buttons {\"OK\"} default button \"OK\" with icon stop" 2>/dev/null || echo "ERROR: $1"
}

# ── Check Node.js ─────────────────────────────────────────────────────────────
NODE_BIN=""
for p in /usr/local/bin/node /opt/homebrew/bin/node "$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node/" 2>/dev/null | tail -1)/bin/node" /usr/bin/node; do
  if [ -x "$p" ]; then NODE_BIN="$p"; break; fi
done
# Also try PATH
if [ -z "$NODE_BIN" ]; then
  NODE_BIN=$(command -v node 2>/dev/null)
fi

if [ -z "$NODE_BIN" ]; then
  alert "Node.js is required but not found.\n\nInstall it from https://nodejs.org (LTS version), then try again."
  exit 1
fi

NODE_VER=$("$NODE_BIN" -e "process.stdout.write(process.version)")
echo "Using Node.js $NODE_VER at $NODE_BIN"

if ! "$NODE_BIN" -e "const [M,m,p]=process.versions.node.split('.').map(Number); process.exit(M>20 || (M===20 && (m>18 || (m===18 && p>=1))) ? 0 : 1)"; then
  alert "Node.js 20.18.1 or newer is required.\n\nFound $NODE_VER at $NODE_BIN. Install a newer Node.js LTS version, then try again."
  exit 1
fi

# ── Check if already running (before touching node_modules under it) ──────
PORT=$("$NODE_BIN" -e "process.stdout.write(String(require('./src/config').DASHBOARD_PORT))" 2>/dev/null || echo 8766)
if lsof -i ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  if curl -fsS "http://127.0.0.1:$PORT/api/stats" 2>/dev/null | grep -q '"queueCount"'; then
    echo "Promo Tracker is already running."
    open "http://127.0.0.1:$PORT"
    exit 0
  fi
  alert "Port $PORT is already in use by another app.\n\nStop that app, or set a different \"port\" in config.local.json."
  exit 1
fi

# ── Check Chrome ──────────────────────────────────────────────────────────────
CHROME="/Applications/Google Chrome.app"
if [ ! -d "$CHROME" ]; then
  alert "Google Chrome is required (Promo Tracker drives it to read sources and apply codes).\n\nInstall it from https://www.google.com/chrome, then try again."
  exit 1
fi

# ── Install npm dependencies if missing or out of date ───────────────────────
# (node_modules/.package-lock.json is npm's record of what's installed; it is
# older than package-lock.json after a git pull that changed dependencies.)
if [ ! -d "$SCRIPT_DIR/node_modules/playwright" ] || [ "$SCRIPT_DIR/package-lock.json" -nt "$SCRIPT_DIR/node_modules/.package-lock.json" ]; then
  echo "Installing dependencies (takes ~30 seconds)..."
  NPM_BIN=$(dirname "$NODE_BIN")/npm
  # Playwright drives the installed Google Chrome, so skip its browser download.
  if ! PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 "$NPM_BIN" ci --omit=dev --no-audit --no-fund >/tmp/promo-tracker-npm.log 2>&1; then
    tail -5 /tmp/promo-tracker-npm.log
    alert "Failed to install dependencies.\n\nCheck your internet connection and try again (details: /tmp/promo-tracker-npm.log)."
    exit 1
  fi
  echo "Dependencies installed."
fi

# ── Create data directory if missing ─────────────────────────────────────────
mkdir -p "$SCRIPT_DIR/data" "$SCRIPT_DIR/archive"

# ── Start the daemon ──────────────────────────────────────────────────────────
LOG="$SCRIPT_DIR/data/daemon.log"
echo "" >> "$LOG"
echo "=== Started at $(date) ===" >> "$LOG"

"$NODE_BIN" "$SCRIPT_DIR/src/index.js" >> "$LOG" 2>&1 &
DAEMON_PID=$!
echo "Daemon started (PID $DAEMON_PID)"

# ── Wait for the server to be ready ──────────────────────────────────────────
echo -n "Waiting for server..."
for i in $(seq 1 20); do
  sleep 0.5
  if lsof -i ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo " ready."
    break
  fi
  echo -n "."
done

# ── Open dashboard ────────────────────────────────────────────────────────────
open "http://127.0.0.1:$PORT"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Promo Tracker is running"
echo "  Dashboard:  http://127.0.0.1:$PORT"
echo "  Log file:   $LOG"
echo ""
echo "  Press Ctrl+C or close this window to stop."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Keep running until killed ─────────────────────────────────────────────────
trap "echo ''; echo 'Stopping...'; kill $DAEMON_PID 2>/dev/null; exit 0" INT TERM
wait $DAEMON_PID
