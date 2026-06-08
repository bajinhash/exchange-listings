#!/bin/bash
# One-shot installer for the local macOS launchd backup runner.
#
# WHY A SEPARATE CLONE: macOS TCC blocks launchd-spawned processes from
# reading ~/Downloads (git → "Operation not permitted", exit 126). The
# user's interactive repo lives in ~/Downloads, so cron can't drive it.
# This sets up a DEDICATED bot clone OUTSIDE Downloads that launchd owns.
#
# What it does (idempotent — safe to re-run):
#   1. Clone the repo to ~/exchange-listings-bot (or pull if it exists)
#   2. npm ci + install Playwright Chromium in that clone
#   3. Deploy scripts/local-cron.sh to a non-protected path
#      (~/Library/Application Support/exchange-listings/) — TCC won't let
#      launchd execute scripts from Downloads either
#   4. Install + (re)load the LaunchAgent (fires 18:00 / 18:30 CST)
#
# Run from anywhere:  bash scripts/install-launchd.sh

set -uo pipefail

BOT_REPO="${EXCHANGE_LISTINGS_REPO:-$HOME/exchange-listings-bot}"
DEPLOY_DIR="$HOME/Library/Application Support/exchange-listings"
DEPLOY_SCRIPT="$DEPLOY_DIR/local-cron.sh"
PLIST="$HOME/Library/LaunchAgents/com.bajinhash.exchange-listings.plist"
LABEL="com.bajinhash.exchange-listings"

# Locate the source repo (where this script lives).
SRC_REPO="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_URL="$(git -C "$SRC_REPO" remote get-url origin 2>/dev/null || echo 'https://github.com/bajinhash/exchange-listings.git')"

echo "==> source repo:   $SRC_REPO"
echo "==> remote:        $REMOTE_URL"
echo "==> bot clone:     $BOT_REPO"
echo

# 1. Clone or update the bot clone.
if [ -d "$BOT_REPO/.git" ]; then
  echo "--- bot clone exists, pulling latest ---"
  git -C "$BOT_REPO" fetch origin main && git -C "$BOT_REPO" reset --hard origin/main
else
  echo "--- cloning to $BOT_REPO ---"
  git clone "$REMOTE_URL" "$BOT_REPO" || { echo "ERR: clone failed"; exit 1; }
fi

# 2. Dependencies (Playwright needs its own browser download).
echo
echo "--- npm ci (in bot clone) ---"
( cd "$BOT_REPO" && npm ci ) || { echo "ERR: npm ci failed"; exit 2; }
echo
echo "--- playwright install chromium ---"
( cd "$BOT_REPO" && npx playwright install chromium ) || echo "WARN: playwright install had issues; scrape may fall back"

# 3. Deploy the runner script outside Downloads.
echo
echo "--- deploying runner to $DEPLOY_SCRIPT ---"
mkdir -p "$DEPLOY_DIR"
cp "$SRC_REPO/scripts/local-cron.sh" "$DEPLOY_SCRIPT"
chmod +x "$DEPLOY_SCRIPT"

# 4. Write the LaunchAgent plist.
echo "--- writing $PLIST ---"
mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <!-- Runner lives OUTSIDE ~/Downloads (TCC blocks launchd there). It drives
       a dedicated bot clone at ${BOT_REPO}. -->
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${DEPLOY_SCRIPT}</string>
  </array>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>30</integer></dict>
  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>/tmp/exchange-listings-launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/exchange-listings-launchd.err.log</string>
  <key>ThrottleInterval</key>
  <integer>60</integer>
</dict>
</plist>
PLIST_EOF

# 5. (Re)load the agent.
echo "--- (re)loading LaunchAgent ---"
UID_NUM="$(id -u)"
launchctl bootout "gui/${UID_NUM}" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/${UID_NUM}" "$PLIST" || { echo "ERR: bootstrap failed"; exit 3; }

echo
echo "==> Installed. The agent fires 18:00 / 18:30 CST."
echo "==> Test now:  launchctl kickstart -k gui/${UID_NUM}/${LABEL}"
echo "==> Watch:     tail -f ~/Library/Logs/exchange-listings.log"
