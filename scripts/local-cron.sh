#!/bin/bash
# Local Mac cron — invoked daily by launchd at 18:00 / 18:30 CST.
# Runs the same scrape -> format -> weekly -> git push pipeline as
# GH Actions, but from the Mac's residential IP so Nitter (the Twitter
# source for upcoming Binance Alpha listings) actually returns data.
#
# Idempotent: GH Actions cron may also run; whichever pushes first
# wins, the other re-runs and the soft-reset push logic merges cleanly.
#
# DEPLOYMENT (important — macOS TCC): launchd cannot EXECUTE a script that
# lives inside ~/Downloads (a TCC-protected folder → "Operation not
# permitted", exit 126). So this file is DEPLOYED to a non-protected path
#   ~/Library/Application Support/exchange-listings/local-cron.sh
# and the LaunchAgent points there. `scripts/install-launchd.sh` syncs the
# repo copy to that location and (re)loads the agent. The LOG also lives
# outside Downloads so we can always see failures.
#
# Output: ~/Library/Logs/exchange-listings.log

set -uo pipefail

# REPO is a DEDICATED bot clone living OUTSIDE ~/Downloads. macOS TCC blocks
# launchd-spawned processes from reading ~/Downloads at all (git fails with
# "Operation not permitted"), so the user's interactive Downloads copy can't
# be driven by cron. This clone is created + kept fresh by
# scripts/install-launchd.sh and is the only copy launchd touches. Override
# with EXCHANGE_LISTINGS_REPO if you put it somewhere else.
REPO="${EXCHANGE_LISTINGS_REPO:-$HOME/exchange-listings-bot}"
LOG="$HOME/Library/Logs/exchange-listings.log"
mkdir -p "$(dirname "$LOG")"

# 1MB log rotation
[ -f "$LOG" ] && [ "$(stat -f%z "$LOG")" -gt 1048576 ] && mv "$LOG" "${LOG}.1"

exec >> "$LOG" 2>&1

echo
echo "==================================================="
echo "$(date '+%F %T %Z') local-cron starting"
echo "==================================================="

cd "$REPO" || { echo "ERR: repo dir not found"; exit 1; }

# Make sure node is on PATH — launchd starts with a minimal env.
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:$PATH"

# Use Clash proxy if running (matches what works locally for Bitget / MEXC).
# Skip silently when Clash is off.
if curl -sI -m 2 http://127.0.0.1:7897 >/dev/null 2>&1; then
  export HTTPS_PROXY="http://127.0.0.1:7897"
  export HTTP_PROXY="http://127.0.0.1:7897"
  echo "Clash proxy detected → HTTPS_PROXY set"
fi

echo "node: $(node --version)"
echo "PWD:  $(pwd)"
echo

# Pull latest before running so we don't overwrite GH Actions changes
echo "--- git pull ---"
git pull --rebase 2>&1 || echo "WARN: pull --rebase had conflicts; continuing"

# Self-update: launchd executes a DEPLOYED COPY of this script (outside
# ~/Downloads, see header). After pulling, sync the repo's version of the
# runner over the deployed copy so script fixes take effect on the NEXT
# run without re-running install-launchd.sh. (Never re-exec mid-run.)
DEPLOYED="$HOME/Library/Application Support/exchange-listings/local-cron.sh"
if [ -f "$DEPLOYED" ] && ! cmp -s "$REPO/scripts/local-cron.sh" "$DEPLOYED"; then
  cp "$REPO/scripts/local-cron.sh" "$DEPLOYED" && chmod +x "$DEPLOYED" \
    && echo "runner self-updated from repo (effective next run)"
fi

echo
echo "--- npm run scrape ---"
npm run scrape 2>&1 || { echo "ERR: scrape failed"; exit 2; }

echo
echo "--- npm run basic-format ---"
npm run basic-format 2>&1 || { echo "ERR: basic-format failed"; exit 3; }

echo
echo "--- npm run weekly ---"
npm run weekly 2>&1 || { echo "WARN: weekly failed (non-fatal)"; }

echo
echo "--- git commit + push ---"
DATE=$(TZ=Asia/Shanghai date +%F)
git add data/raw-${DATE}.json data/${DATE}.json data/weekly.json 2>/dev/null || true
if git diff --cached --quiet; then
  echo "no data changes to commit"
else
  git commit -m "data: local-cron scrape ${DATE}"
  for attempt in 1 2 3; do
    if git push; then break; fi
    echo "push attempt $attempt failed; resetting onto latest remote"
    git fetch origin main || { echo "fetch failed"; exit 4; }
    # Use --mixed (not --soft) so the commit only contains our data/ changes
    # on top of whatever's now on origin/main. With --soft the prior commit's
    # index was preserved, which would silently revert any non-data file (e.g.
    # scraper.js fix, scripts/local-cron.sh itself) that landed on origin/main
    # between our pull and our push.
    git reset --mixed origin/main || { echo "reset failed"; exit 5; }
    git add data/raw-${DATE}.json data/${DATE}.json data/weekly.json 2>/dev/null || true
    if git diff --cached --quiet; then
      echo "no diff vs remote — already pushed by GH Actions"
      break
    fi
    git commit -m "data: local-cron scrape ${DATE}"
  done
fi

echo
echo "$(date '+%F %T %Z') local-cron done"
