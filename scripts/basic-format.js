// Basic rule-based formatter (no AI required).
//
// Reads data/raw-YYYY-MM-DD.json (scraper output), filters to today's CST
// publish window, extracts token/type/detail/url via regex per exchange,
// and writes data/YYYY-MM-DD.json that app.js consumes.
//
// This is a fallback when ANTHROPIC_API_KEY is not configured for the
// nicer AI-driven format.js. Quality is ~80% — bulk-listing announcements
// (e.g. "AMD/QCOM/USAR perps") collapse to a single row.

const fs = require('fs');
const path = require('path');

const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;
const TODAY = process.argv[2] || new Date(Date.now() + SHANGHAI_OFFSET_MS).toISOString().split('T')[0];
const DATA_DIR = path.join(__dirname, '..', 'data');
const RAW = path.join(DATA_DIR, `raw-${TODAY}.json`);
const OUT = path.join(DATA_DIR, `${TODAY}.json`);

// 24-hour rolling window ending at the moment this script runs.
// Cron runs at 18:00 CST → cutoff = 18:00 CST the previous day, exactly
// what the user asked for. Manual runs slide the window accordingly.
const WINDOW_END_MS = Date.now();
const WINDOW_START_MS = WINDOW_END_MS - 24 * 3600 * 1000;
// CST dates that overlap the window — used as fallback when only date (no time)
// is available. covers (yesterday CST, today CST).
const TODAY_CST = new Date(WINDOW_END_MS + SHANGHAI_OFFSET_MS).toISOString().split('T')[0];
const YESTERDAY_CST = new Date(WINDOW_END_MS + SHANGHAI_OFFSET_MS - 86400_000).toISOString().split('T')[0];

// ---- date parser (handles every exchange's quirky date format) ------------
function nowCstDate() {
  return new Date(Date.now() + SHANGHAI_OFFSET_MS).toISOString().split('T')[0];
}
function yyyymmdd(d) { return d.toISOString().split('T')[0]; }

// Returns {ts: ms-epoch | null, date: 'YYYY-MM-DD' | null}.
// ts populated when we can determine exact publish time; date is a coarser
// fallback used when only the date portion is known.
function parsePublishTime(item) {
  const body = item.body || '';
  const title = item.title || '';
  const text = `${title}\n${body}`;
  let m;
  // 1a. "Published: ISO_TIMESTAMP" (Bybit) — full precision
  if ((m = text.match(/Published:?\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/))) {
    const ts = Date.parse(m[1]);
    if (!isNaN(ts)) return { ts, date: m[1].slice(0, 10) };
  }
  // 1b. "Published: YYYY-MM-DD" (date only — OKX/scraper-injected)
  if ((m = text.match(/Published:?\s*(\d{4}-\d{2}-\d{2})\b/))) {
    return { ts: null, date: m[1] };
  }
  // 1b. "Published on Month D, YYYY" (OKX titles, date only)
  if ((m = text.match(/Published on (\w+) (\d{1,2}),\s*(\d{4})/))) {
    const d = new Date(`${m[1]} ${m[2]}, ${m[3]} UTC`);
    if (!isNaN(d)) return { ts: null, date: yyyymmdd(d) };
  }
  // 2. "MM/DD/YYYY, HH:MM:SS" (KuCoin) — IS publish date. Check BEFORE the
  //    generic YYYY-MM-DD HH:MM rule because KuCoin's body also contains the
  //    listing schedule in YYYY-MM-DD HH:MM form, which would otherwise win.
  if ((m = text.match(/(\d{2})\/(\d{2})\/(\d{4})/))) {
    return { ts: null, date: `${m[3]}-${m[1]}-${m[2]}` };
  }
  // 3. "YYYY-MM-DD HH:MM" inside body (Bitget article header — has CST time!)
  if ((m = text.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/))) {
    // Interpret as CST (UTC+8) since Bitget pages render in zh-CN
    const cstMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    const utcMs = cstMs - SHANGHAI_OFFSET_MS;
    return { ts: utcMs, date: `${m[1]}-${m[2]}-${m[3]}` };
  }
  // 4. Relative Chinese time (MEXC: "X 分鐘前", "X 小時前", "X 天前") — has exact ts
  if ((m = text.match(/(\d+)\s*分[鐘钟]前/))) {
    const ts = Date.now() - parseInt(m[1]) * 60_000;
    return { ts, date: yyyymmdd(new Date(ts + SHANGHAI_OFFSET_MS)) };
  }
  if ((m = text.match(/大約\s*(\d+)\s*小[時时]前|(\d+)\s*小[時时]前/))) {
    const n = parseInt(m[1] || m[2]);
    const ts = Date.now() - n * 3600_000;
    return { ts, date: yyyymmdd(new Date(ts + SHANGHAI_OFFSET_MS)) };
  }
  if ((m = text.match(/(\d+)\s*天前/))) {
    const ts = Date.now() - parseInt(m[1]) * 86400_000;
    return { ts, date: yyyymmdd(new Date(ts + SHANGHAI_OFFSET_MS)) };
  }
  if (/剛剛|刚刚|seconds? ago|一個小時前|一个小时前/.test(text)) {
    return { ts: Date.now(), date: TODAY_CST };
  }
  // 5. Gate.io trailing-date pattern: "...2026-05-066,591" (date + view count).
  //    The date here IS the publish date, unlike Binance's parenthesized
  //    "(2026-05-18)" which is the future listing date.
  //    Match: date immediately followed by digit (view-count) or end-of-string.
  if ((m = text.match(/(\d{4})-(\d{2})-(\d{2})(?=\d|\s*$|<)/))) {
    return { ts: null, date: `${m[1]}-${m[2]}-${m[3]}` };
  }
  // NOTE: deliberately do NOT parse "(YYYY-MM-DD)" in title — that's almost
  // always the *listing* date, not the publish date (e.g. Binance "Will Launch
  // BTCUSD1 (2026-05-18)" was published 5/14 but lists 5/18).
  // If we can't determine pub date, return nulls — inWindow accepts unknowns
  // as "probably recent" (scrapers fetch latest items, ordered desc).
  return { ts: null, date: null };
}

// Common false-positive tokens / brand names to skip when matching.
const BANNED_TOKEN = new Set([
  'UTC', 'USD', 'USDT', 'USDC', 'EUR', 'TRY', 'JPY', 'GBP', 'CNY', 'KZT',
  'ETF', 'CFD', 'NFT', 'API', 'KOL', 'AI', 'AML', 'KYC', 'FAQ', 'VIP', 'CEO',
  'AMA', 'IPO', 'TWT', 'PR', 'HODLER', 'TRADING', 'NEW', 'SPOT', 'PERPETUAL',
  // Brand names
  'MEXC', 'OKX', 'BINANCE', 'BYBIT', 'KUCOIN', 'GATE', 'HTX', 'BITGET',
  'KRAKEN', 'COINBASE',
]);
const BRAND_LOWER = new Set([
  'mexc', 'okx', 'binance', 'bybit', 'kucoin', 'gate', 'htx', 'bitget',
  'launchpool', 'launchpad', 'tradfi', 'meme+',
]);

// Bulk-listing token extractor: when a single announcement bundles N
// listings ("Will List Multiple Stock Index Perpetual Contracts"), the
// body contains a schedule like:
//   2026-05-15 14:05 (UTC): DISUSDT-Margined Perpetual Contract, ...
//   2026-05-15 14:05 (UTC): UBERUSDT-Margined Perpetual Contract, ...
// This walks the body to pull each TICKER out. Returns sorted unique array.
function extractTokensFromBody(item) {
  const body = item.body || '';
  const tokens = new Set();
  // Pattern 1: TICKERUSDT-Margined / TICKERUSDT 永續 / TICKERUSDT 永续
  for (const m of body.matchAll(/\b([A-Z][A-Z0-9]{1,14})USDT[-\s]?(?:Margined|Perpetual|永續|永续|合約|合约)/g)) {
    if (!BANNED_TOKEN.has(m[1])) tokens.add(m[1]);
  }
  // Pattern 2: enumeration "TICKER1, TICKER2 and TICKER3" (Binance Multiple TradFi style)
  for (const m of body.matchAll(/\b([A-Z][A-Z0-9]{2,14})\s*(?:[,]\s+|\s+(?:and|及|和)\s+)/g)) {
    if (!BANNED_TOKEN.has(m[1])) tokens.add(m[1]);
  }
  // Pattern 3: bullet list "1. TICKER" or "• TICKER"
  for (const m of body.matchAll(/[•·\-]\s+([A-Z][A-Z0-9]{2,14})\b/g)) {
    if (!BANNED_TOKEN.has(m[1])) tokens.add(m[1]);
  }
  return [...tokens].sort();
}

// Returns an array of tokens for this item. Most items → [single token];
// bulk listings → multiple tokens parsed from body.
function extractTokens(item) {
  const single = extractToken(item);
  // Only do bulk expansion when title flagged it as "多个" or single failed (?)
  if (single !== '多个' && single !== '?' && single !== 'TradFi') {
    return [single];
  }
  const bulk = extractTokensFromBody(item);
  if (bulk.length > 0) return bulk;
  return [single];   // keep "多个" / "TradFi" / "?" placeholder when body is empty
}

// ---- ticker / type extractors --------------------------------------------
function extractToken(item) {
  const title = item.title || '';
  // 0. Bulk-listing phrases → "多个" (better than "?" for the UI)
  if (/Multiple\s+(?:USD|TradFi|Perpetual|Stock|股票)|多個|多个|多種|多种/i.test(title)) {
    return '多个';
  }
  // 0b. "TradFi 股票上新" or any "TradFi" branded listing → TradFi (Bybit/Binance)
  if (/TradFi\s*(股票|stock)?/i.test(title) && !/USDT|USDC/.test(title)) {
    return 'TradFi';
  }
  // 1. TICKERUSDT (perpetual notation — strongest signal). Allow up to 15 chars.
  const usdtAll = [...title.matchAll(/\b([A-Z][A-Z0-9]{1,14})USDT\b/g)];
  for (const m of usdtAll) if (!BANNED_TOKEN.has(m[1])) return m[1];
  // 2. TICKER-USDT or TICKER/USDT
  const dashedAll = [...title.matchAll(/\b([A-Z][A-Z0-9]{1,14})[/-]USD[TC]?\b/g)];
  for (const m of dashedAll) if (!BANNED_TOKEN.has(m[1])) return m[1];
  // 3. "Name (TICKER)"
  const parens = [...title.matchAll(/\(([A-Z][A-Z0-9]{0,14})\)/g)];
  for (const m of parens) if (!BANNED_TOKEN.has(m[1])) return m[1];
  // 4. After "List/launch/上线/上币/首发" (uppercase-only, no brand names)
  const listed = title.match(/(?:List|Launch|上線|上线|上币|上幣|首發|首发)[：:\s]+([A-Z][A-Z0-9]{1,14})\b/);
  if (listed && !BANNED_TOKEN.has(listed[1])) return listed[1];
  // 5. Project name before "将上线" / "现已上线" (allows mixed-case names like preOPAI)
  const before = title.match(/([A-Za-z][A-Za-z0-9]{2,14})\s*[（(]?[A-Z]*[）)]?\s*(?:将上线|現已上線|现已上线|將上線|即將上線|即将上线)/);
  if (before && !BRAND_LOWER.has(before[1].toLowerCase()) && !BANNED_TOKEN.has(before[1].toUpperCase())) return before[1];
  // 6. "USD-Margined TICKER" / "TICKER Perpetual" pattern (Binance style, where
  //    a special pair like BTCUSD1 doesn't end in USDT)
  const inline = title.match(/(?:USD[Ⓢ⒮S]?-?Margined|USDⓈ-Margined)\s+([A-Z][A-Z0-9]{2,14})\b/);
  if (inline && !BANNED_TOKEN.has(inline[1])) return inline[1];
  // 7. First standalone uppercase 3-15 letter word
  const tokens = [...title.matchAll(/\b([A-Z][A-Z0-9]{2,14})\b/g)];
  for (const m of tokens) if (!BANNED_TOKEN.has(m[1])) return m[1];
  return '?';
}

function extractType(item) {
  // Use ONLY title for type detection — body has noise from sidebar/related links
  // (e.g. an ILY spot announcement's body mentions a nearby preOPAI Pre-IPO article).
  const t = item.title || '';
  const lc = t.toLowerCase();
  // Most specific first
  if (/meme\+/i.test(t)) return 'Meme+ 现货';
  if (/pre[\s-]?ipo|Pre-IPO|预上市|預上市/i.test(t)) return 'Pre-IPO 上线';
  if (/launchpool/i.test(lc)) return 'Launchpool';
  if (/launchpad/i.test(lc)) return 'Launchpad';
  if (/copy[\s-]?trade|跟單|跟单/i.test(t)) return '跟单合约';
  if (/股票指数|股票指數|stock index|stock-index/i.test(t)) return '美股合约';
  if (/perpetual|永续合约|永續合約|u本位|usd[Ⓢ⒮]?-?margined|合約創新板塊|合约创新板块/i.test(t)) return '永续合约';
  if (/margin|杠杆|槓桿/i.test(t)) return '杠杆上线';
  if (/(spot|现货|現貨|上币|上幣|首发|首發|首發上線|首发上线|list|launch)/i.test(t)) return '现货上线';
  return '上线';
}

function makeDetail(item) {
  let s = (item.title || '').trim();
  // Strip "Published on Month D, YYYY..." suffix (OKX)
  s = s.replace(/Published on \w+ \d{1,2},\s*\d{4}.*$/, '').trim();
  // Strip noisy doubled titles (KuCoin double-renders the title)
  s = s.replace(/(.{20,}?)\1/, '$1');
  // Strip trailing "MM/DD/YYYY, HH:MM:SS" timestamp (KuCoin)
  s = s.replace(/\s*\d{2}\/\d{2}\/\d{4},\s*\d{2}:\d{2}:\d{2}.*$/, '').trim();
  // Strip view counter trailing pattern (Gate.io: title2026-05-0616,627)
  s = s.replace(/(\d{4}-\d{2}-\d{2})\d{2,}.*$/, '$1');
  // Strip leading "首發上線：" / "首发上线：" / "【首发上币】" decorative prefixes
  s = s.replace(/^(首發上線|首发上线|首發上市|首发上市)[：:]\s*/, '');
  s = s.replace(/^【[^】]*】\s*/, '');
  if (s.length > 180) s = s.slice(0, 177) + '...';
  return s;
}

// ---- filter window --------------------------------------------------------
// Rolling 24h ending at run time. At the 18:00 CST cron firing, that's
// yesterday 18:00 CST → today 18:00 CST. Exact ts comparison when possible,
// fall back to date-equality with today-or-yesterday CST when only a date
// is known.
function inWindow(parsed) {
  if (parsed.ts !== null) {
    return parsed.ts >= WINDOW_START_MS && parsed.ts <= WINDOW_END_MS;
  }
  if (parsed.date) {
    return parsed.date === TODAY_CST || parsed.date === YESTERDAY_CST;
  }
  // Unknown publish date — assume "recent" because the scraper just fetched
  // the latest items. Better to over-include than to silently drop entries
  // like Binance's BTCUSD1 (title only has the future listing date).
  return true;
}

// ---- denylist (drop noise rows) ------------------------------------------
// Includes "promotional / reward / lottery" patterns so things like
// 「百倍收益圍獵計畫第 3 期：50,000 USDT 獎勵」 don't end up in the daily.
const DENY = /Trading Competition|AMA|Completes Integration|Alpha Will Remove|Competition|Campaign|Maintenance|系統維護|System Maintenance|Institutions and VIPs|Getting started|Announcements$|Latest announcements|Trading updates|定投|手续费|手續費|下架|百倍|圍獵|围猎|獵計|獎勵等您|奖励等您|盲盒|奖池|獎池|抽獎|抽奖|福利|現金獎|现金奖|送禮|送礼/i;

function isDenied(item) {
  return DENY.test(item.title || '');
}

// ---- per-exchange formatter ----------------------------------------------
function formatExchange(key, rawArr) {
  const out = [];
  const seen = new Set();
  for (const item of rawArr) {
    if (!item || !item.title || isDenied(item)) continue;
    const pub = parsePublishTime(item);
    if (!inWindow(pub)) continue;
    const tokens = extractTokens(item);
    const type = extractType(item);
    const baseDetail = makeDetail(item);
    for (const token of tokens) {
      const dedupKey = `${key}|${token}|${type}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      // For bulk-expanded entries, prepend the specific token so each row's
      // detail is self-explanatory (otherwise N rows would share identical text).
      const detail = tokens.length > 1
        ? `${token}USDT 永续合约（同公告含 ${tokens.length} 个标的）`
        : baseDetail;
      out.push({ token, type, detail, url: item.url || '' });
    }
  }
  return out;
}

// ---- Binance bucketing (listings / alpha / wallet) -----------------------
function bucketBinance(rawArr) {
  const listings = [], alpha = [], wallet = [];
  const seen = new Set();
  for (const item of rawArr) {
    if (!item || !item.title || isDenied(item)) continue;
    const pub = parsePublishTime(item);
    if (!inWindow(pub)) continue;
    const tokens = extractTokens(item);
    const type = extractType(item);
    const baseDetail = makeDetail(item);
    const t = item.title || '';
    for (const token of tokens) {
      const dedupKey = `binance|${token}|${type}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      const detail = tokens.length > 1
        ? `${token}USDT 永续合约（同公告含 ${tokens.length} 个标的）`
        : baseDetail;
      const entry = { token, type, detail, url: item.url || '' };
      if (/Alpha/.test(t)) alpha.push(entry);
      else if (/Wallet/.test(t)) wallet.push(entry);
      else listings.push(entry);
    }
  }
  return { listings, alpha, wallet };
}

// ---- main ----------------------------------------------------------------
function main() {
  if (!fs.existsSync(RAW)) {
    console.error(`[basic-format] no raw file at ${RAW}`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(RAW, 'utf-8'));
  const ex = raw.exchanges || {};
  const out = {
    date: TODAY,
    updatedAt: new Date().toISOString(),
    exchanges: {
      binance: bucketBinance(ex.binance || []),
      okx:     { listings: formatExchange('okx',     ex.okx     || []) },
      bybit:   { listings: formatExchange('bybit',   ex.bybit   || []) },
      kucoin:  { listings: formatExchange('kucoin',  ex.kucoin  || []) },
      gateio:  { listings: formatExchange('gateio',  ex.gateio  || []) },
      bitget:  { listings: formatExchange('bitget',  ex.bitget  || []) },
      mexc:    { listings: formatExchange('mexc',    ex.mexc    || []) },
    },
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf-8');

  const counts = Object.entries(out.exchanges).map(([k, v]) => {
    const n = (v.listings?.length || 0) + (v.alpha?.length || 0) + (v.wallet?.length || 0);
    return `${k}=${n}`;
  }).join('  ');
  const fmt = (ms) => new Date(ms + SHANGHAI_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 16);
  console.log(`[basic-format] window: ${fmt(WINDOW_START_MS)} → ${fmt(WINDOW_END_MS)} CST (24h rolling)`);
  console.log(`[basic-format] counts: ${counts}`);
  console.log(`[basic-format] wrote ${OUT}`);
}

main();
