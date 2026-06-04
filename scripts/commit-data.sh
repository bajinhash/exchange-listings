#!/bin/bash
# Safe idempotent commit + push of one day's data files.
#
# WHY THIS EXISTS: the obvious "sync to remote" command
#     git checkout origin/main -- data/
# CLOBBERS freshly-scraped local data with the remote's older version.
# It bit us twice on 2026-06-03 — a fresh local scrape (full OKX/Bybit/
# KuCoin/MEXC data) got silently replaced by GitHub Actions' sparse
# early-run files. NEVER use `git checkout origin/main -- data/`.
#
# The correct race-safe sync is: fetch -> reset --mixed origin/main ->
# re-stage ONLY our specific files -> recommit. `reset --mixed` moves the
# branch pointer but leaves the working tree untouched, so our scraped
# data survives; we then stage exactly the files we own.
#
# Usage: scripts/commit-data.sh [YYYY-MM-DD]   (defaults to today, CST)

set -uo pipefail
cd "$(dirname "$0")/.." || { echo "repo dir not found"; exit 1; }

DATE="${1:-$(TZ=Asia/Shanghai date +%F)}"
FILES=("data/raw-${DATE}.json" "data/${DATE}.json" "data/weekly.json")

git add "${FILES[@]}" 2>/dev/null || true
if git diff --cached --quiet; then
  echo "no staged changes for ${DATE}"
  exit 0
fi

git commit -m "data: scrape + format ${DATE}"

for attempt in 1 2 3; do
  if git push; then
    echo "pushed ${DATE}"
    exit 0
  fi
  echo "push $attempt failed; syncing onto origin/main (reset --mixed — NEVER checkout)"
  git fetch origin main || { echo "fetch failed"; exit 1; }
  git reset --mixed origin/main || { echo "reset failed"; exit 1; }
  git add "${FILES[@]}" 2>/dev/null || true
  if git diff --cached --quiet; then
    echo "remote already current for ${DATE}"
    exit 0
  fi
  git commit -m "data: scrape + format ${DATE}"
done

echo "push failed after 3 attempts" >&2
exit 1
