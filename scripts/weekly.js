// Weekly recap aggregator.
//
// Reads the last 7 daily JSON files (data/YYYY-MM-DD.json) and produces a
// deduplicated rollup at data/weekly.json. Each listing keeps a `dates`
// array recording every day it appeared, so the UI can show "重复出现 3 天"
// style indicators.
//
// Dedup key:    `${exchange}|${bucket}|${normalized(token)}|${normalized(type)}`
// Sort:         most recent date first (within each bucket)

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const END = process.argv[2] || new Date().toISOString().split('T')[0];

function daysBack(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().split('T')[0];
}

function normalize(s) {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function dedupKey(exchange, bucket, item) {
  return `${exchange}|${bucket}|${normalize(item.token)}|${normalize(item.type)}`;
}

function mergeBucket(bucketMap, exchange, bucket, items, date) {
  for (const it of items || []) {
    const key = dedupKey(exchange, bucket, it);
    const existing = bucketMap.get(key);
    if (existing) {
      if (!existing.dates.includes(date)) existing.dates.push(date);
      // keep first seen detail/url; prefer earlier (most informative) entry
    } else {
      bucketMap.set(key, { ...it, dates: [date] });
    }
  }
}

function sortByDateDesc(arr) {
  return arr.sort((a, b) => {
    const ad = a.dates[a.dates.length - 1]; // latest day this item appeared
    const bd = b.dates[b.dates.length - 1];
    return bd.localeCompare(ad);
  });
}

function main() {
  const dates = [];
  for (let i = 0; i < 7; i++) dates.push(daysBack(END, i));
  dates.reverse(); // chronological order, oldest first

  const EXCHANGES = ['binance', 'okx', 'bybit', 'kucoin', 'gateio', 'bitget', 'mexc', 'htx'];
  const buckets = {};
  for (const ex of EXCHANGES) {
    buckets[ex] = {
      listings: new Map(),
      alpha:    new Map(),
      wallet:   new Map(),
    };
  }

  const seen = [];
  for (const d of dates) {
    const f = path.join(DATA_DIR, `${d}.json`);
    if (!fs.existsSync(f)) continue;
    seen.push(d);
    const day = JSON.parse(fs.readFileSync(f, 'utf-8'));
    for (const [ex, data] of Object.entries(day.exchanges || {})) {
      if (!buckets[ex]) continue;
      mergeBucket(buckets[ex].listings, ex, 'listings', data.listings, d);
      if (ex === 'binance') {
        mergeBucket(buckets[ex].alpha,  ex, 'alpha',  data.alpha,  d);
        mergeBucket(buckets[ex].wallet, ex, 'wallet', data.wallet, d);
      }
    }
  }

  if (seen.length === 0) {
    console.error('[weekly] no daily JSON files found in last 7 days — nothing to aggregate.');
    process.exit(0);
  }

  // Materialize maps into arrays
  const out = { weekStart: seen[0], weekEnd: seen[seen.length - 1], updatedAt: new Date().toISOString(), exchanges: {} };
  for (const ex of EXCHANGES) {
    const node = { listings: sortByDateDesc([...buckets[ex].listings.values()]) };
    if (ex === 'binance') {
      node.alpha  = sortByDateDesc([...buckets[ex].alpha.values()]);
      node.wallet = sortByDateDesc([...buckets[ex].wallet.values()]);
    }
    out.exchanges[ex] = node;
  }

  const outPath = path.join(DATA_DIR, 'weekly.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf-8');

  // Summary
  const counts = Object.entries(out.exchanges).map(([k, v]) => {
    const n = (v.listings?.length || 0) + (v.alpha?.length || 0) + (v.wallet?.length || 0);
    return `${k}=${n}`;
  }).join('  ');
  console.log(`[weekly] window: ${seen[0]} → ${seen[seen.length - 1]} (${seen.length} days)`);
  console.log(`[weekly] counts: ${counts}`);
  console.log(`[weekly] wrote ${outPath}`);
}

main();
