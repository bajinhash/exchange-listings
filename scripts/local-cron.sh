#!/bin/bash
# Local Mac cron — invoked daily by launchd at 18:00 / 18:30 CST.
# Runs the same scrape -> format -> weekly -> git push pipeline as
# GH Actions, but from the Mac's residential IP so Nitter (the Twitter
# source for upcoming Binance Alpha listings) actually returns data.
#
# Idempotent: GH Actions cron may also run; whichever pushes first
# wins, the other re-runs and the soft-reset push logic merges cleanly.
#
# Output: ~/Downloads/claude\ code/exchange-listings/local-cron.log

set -uo pipefail

REPO="$HOME/Downloads/claude code/exchange-listings"
LOG="$REPO/local-cron.log"

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
    echo "push attempt $attempt failed; soft-resetting onto latest remote"
    git fetch origin main || { echo "fetch failed"; exit 4; }
    git reset --soft origin/main || { echo "reset failed"; exit 5; }
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
