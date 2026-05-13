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

// ---- date parser (handles every exchange's quirky date format) ------------
function nowCstDate() {
  return new Date(Date.now() + SHANGHAI_OFFSET_MS).toISOString().split('T')[0];
}
function yyyymmdd(d) { return d.toISOString().split('T')[0]; }

function parsePublishDate(item) {
  const body = item.body || '';
  const title = item.title || '';
  const text = `${title}\n${body}`;
  let m;
  // 1. "Published: YYYY-MM-DD" (Bybit, OKX, HTX bodies set by scraper)
  if ((m = text.match(/Published:?\s*(\d{4}-\d{2}-\d{2})/))) return m[1];
  // 2. "Published on Month D, YYYY" (OKX titles)
  if ((m = text.match(/Published on (\w+) (\d{1,2}),\s*(\d{4})/))) {
    const d = new Date(`${m[1]} ${m[2]}, ${m[3]} UTC`);
    if (!isNaN(d)) return yyyymmdd(d);
  }
  // 3. "YYYY-MM-DD HH:MM" inside body (Bitget article-header timestamps)
  if ((m = text.match(/(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}/))) return m[1];
  // 4. "MM/DD/YYYY, HH:MM:SS" (KuCoin)
  if ((m = text.match(/(\d{2})\/(\d{2})\/(\d{4})/))) return `${m[3]}-${m[1]}-${m[2]}`;
  // 5. "(YYYY-MM-DD)" or "(YYYY-MM-DD HH:MM)" in title (KuCoin futures)
  if ((m = text.match(/\((\d{4}-\d{2}-\d{2})\)/))) return m[1];
  // 6. Relative Chinese time (MEXC: "X 分鐘前", "X 小時前", "X 天前")
  if ((m = text.match(/(\d+)\s*分[鐘钟]前/))) {
    return yyyymmdd(new Date(Date.now() - parseInt(m[1]) * 60_000));
  }
  if ((m = text.match(/大約\s*(\d+)\s*小[時时]前|(\d+)\s*小[時时]前/))) {
    const n = parseInt(m[1] || m[2]);
    return yyyymmdd(new Date(Date.now() - n * 3600_000));
  }
  if ((m = text.match(/(\d+)\s*天前/))) {
    return yyyymmdd(new Date(Date.now() - parseInt(m[1]) * 86400_000));
  }
  if (/剛剛|刚刚|剛剛|seconds? ago|一[個个]?小時前/.test(text)) return TODAY;
  // 7. last resort: any YYYY-MM-DD in title (Binance: "...(2026-05-07)")
  if ((m = text.match(/(\d{4}-\d{2}-\d{2})/))) return m[1];
  return null;
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

// ---- ticker / type extractors --------------------------------------------
function extractToken(item) {
  const title = item.title || '';
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
  const before = title.match(/([A-Za-z][A-Za-z0-9]{2,14})\s*[（(]?[A-Z]*[）)]?\s*(?:将上线|現已上線|现已上线|將上線)/);
  if (before && !BRAND_LOWER.has(before[1].toLowerCase()) && !BANNED_TOKEN.has(before[1].toUpperCase())) return before[1];
  // 6. First standalone uppercase 3-15 letter word
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
// Briefing window = today 00:00 → today 18:00 CST. In date terms we keep
// items whose pub date is TODAY (CST). Cross-day Meme+ posted late
// yesterday is included if it's within 24h relative time (handled by parser).
function inWindow(pubDate) {
  if (!pubDate) return false;
  return pubDate === TODAY;
}

// ---- denylist (drop noise rows) ------------------------------------------
const DENY = /Trading Competition|AMA|Completes Integration|Alpha Will Remove|Competition|Campaign|Maintenance|系統維護|System Maintenance|Institutions and VIPs|Getting started|Announcements$|Latest announcements|Trading updates|定投|手续费|手續費|下架/i;

function isDenied(item) {
  return DENY.test(item.title || '');
}

// ---- per-exchange formatter ----------------------------------------------
function formatExchange(key, rawArr) {
  const out = [];
  const seen = new Set();
  for (const item of rawArr) {
    if (!item || !item.title || isDenied(item)) continue;
    const pubDate = parsePublishDate(item);
    if (!inWindow(pubDate)) continue;
    const token = extractToken(item);
    const type = extractType(item);
    const detail = makeDetail(item);
    const dedupKey = `${key}|${token}|${type}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push({
      token,
      type,
      detail,
      url: item.url || '',
    });
  }
  return out;
}

// ---- Binance bucketing (listings / alpha / wallet) -----------------------
function bucketBinance(rawArr) {
  const listings = [], alpha = [], wallet = [];
  const seen = new Set();
  for (const item of rawArr) {
    if (!item || !item.title || isDenied(item)) continue;
    const pubDate = parsePublishDate(item);
    if (!inWindow(pubDate)) continue;
    const token = extractToken(item);
    const type = extractType(item);
    const detail = makeDetail(item);
    const dedupKey = `binance|${token}|${type}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const entry = { token, type, detail, url: item.url || '' };
    const t = item.title || '';
    if (/Alpha/.test(t)) alpha.push(entry);
    else if (/Wallet/.test(t)) wallet.push(entry);
    else listings.push(entry);
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
  console.log(`[basic-format] window: ${TODAY} (00:00 → 18:00 CST)`);
  console.log(`[basic-format] counts: ${counts}`);
  console.log(`[basic-format] wrote ${OUT}`);
}

main();
