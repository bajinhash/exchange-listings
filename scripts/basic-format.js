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

// Briefing window: starts at yesterday 18:00 CST (fixed), ends at
// MAX(today 18:00 CST, NOW) so cron-delayed runs still catch items
// posted between 18:00 and the actual fire time. Capped at +6h to avoid
// late manual reruns bleeding into the next day's briefing.
const [_Y, _M, _D] = TODAY.split('-').map(Number);
const SCHEDULED_END_MS = Date.UTC(_Y, _M - 1, _D, 10, 0, 0);  // 18:00 CST
const MAX_DELAY_MS = 6 * 3600 * 1000;
const WINDOW_END_MS = Math.max(
  SCHEDULED_END_MS,
  Math.min(Date.now() + 60_000, SCHEDULED_END_MS + MAX_DELAY_MS)
);
const WINDOW_START_MS = SCHEDULED_END_MS - 24 * 3600 * 1000;
// CST date fallbacks for date-only (no time) items
const TODAY_CST = TODAY;
const YESTERDAY_CST = new Date(WINDOW_START_MS).toISOString().split('T')[0];

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
  // 1a-okx. OKX titles always carry their own publish date as
  //   "公告發佈於 YYYY年M月D日" / "公告发布于 YYYY年M月D日". This is the
  //   announcement publish date (authoritative — not a future schedule).
  //   Check this BEFORE the generic Chinese-date scanner so it wins over
  //   any in-body schedule strings.
  if ((m = title.match(/公告(?:發佈於|发布于)\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/))) {
    return {
      ts: null,
      date: `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`,
    };
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
  //    Prefer the variant with time (more precise window filtering).
  if ((m = text.match(/(\d{2})\/(\d{2})\/(\d{4}),\s*(\d{2}):(\d{2}):(\d{2})/))) {
    // KuCoin timestamps render in CST. Convert to UTC ms.
    const cstMs = Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]);
    const utcMs = cstMs - SHANGHAI_OFFSET_MS;
    return { ts: utcMs, date: `${m[3]}-${m[1]}-${m[2]}` };
  }
  // Fallback: date only (no time)
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
  // 3b. Chinese date with time, but ONLY when the TITLE indicates this is
  //     an "already done" change ("現已支援", "已新增"). Otherwise the
  //     Chinese dates in body are a future schedule (e.g. HOOLI body has
  //     "交易：2026年5月15日 18:00 (UTC+8)" — that's the trading start time,
  //     not the publish time).
  // Title verbs that mean "this announcement is about something that already
  // happened / is happening NOW" — so any Chinese date in body is the publish/
  // effective time, not a future schedule.
  const TITLE_DONE = /現已|现已|已新增|已開啟|已开通|已支援|已支持|已上線|已上线|已增加|正式上線|正式上线|現已上線|现已上线/;
  if (TITLE_DONE.test(title)) {
    for (const cm of text.matchAll(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2}):(\d{2})/g)) {
      const cstMs = Date.UTC(+cm[1], +cm[2] - 1, +cm[3], +cm[4], +cm[5]);
      const utcMs = cstMs - SHANGHAI_OFFSET_MS;
      const ageMs = Date.now() - utcMs;
      if (ageMs >= 0 && ageMs < 48 * 3600 * 1000) {
        return {
          ts: utcMs,
          date: `${cm[1]}-${String(cm[2]).padStart(2,'0')}-${String(cm[3]).padStart(2,'0')}`,
        };
      }
    }
  }
  // 3c. MEXC stock-futures "將於 M/D 上線" — the title carries the explicit
  //     listing date, which is far more reliable than the coarse "X 天前"
  //     relative time in the body. e.g. "新美股合約上線：HPE U 本位合約將於
  //     6/2 上線，限時享受 0 費" is published "1 天前" — the X*24+12h midpoint
  //     pushes it just outside the 24h window and drops it, even though the
  //     6/2 listing is squarely in the yesterday-18:00→today window.
  //     Mark these `loose: true` so inWindow accepts today OR yesterday.
  if (/上[線线]/.test(title)) {
    const md = title.match(/(\d{1,2})\/(\d{1,2})\s*上?\s*線|（?(\d{1,2})\/(\d{1,2})）?\s*上[線线]|將於\s*(\d{1,2})\/(\d{1,2})|将于\s*(\d{1,2})\/(\d{1,2})/);
    const mdSimple = title.match(/(\d{1,2})\/(\d{1,2})\s*上[線线]/);
    const pick = mdSimple || md;
    if (pick) {
      const nums = pick.slice(1).filter(Boolean).map(Number);
      if (nums.length >= 2) {
        const mm = String(nums[0]).padStart(2, '0');
        const dd = String(nums[1]).padStart(2, '0');
        return { ts: null, date: `${_Y}-${mm}-${dd}`, loose: true };
      }
    }
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
    // "X 天前" on MEXC etc. is rounded down (covers X*24h to (X+1)*24h ago).
    // Use the MIDPOINT (X*24 + 12h) to filter conservatively: items right
    // at the 24h boundary correctly fall before the 18:00→18:00 window.
    const hoursAgo = parseInt(m[1]) * 24 + 12;
    const ts = Date.now() - hoursAgo * 3600_000;
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
  'ETF', 'CFD', 'NFT', 'API', 'KOL', 'AML', 'KYC', 'FAQ', 'VIP', 'CEO',
  'AMA', 'IPO', 'TWT', 'PR', 'HODLER', 'TRADING', 'NEW', 'SPOT', 'PERPETUAL',
  // Brand names
  'MEXC', 'OKX', 'BINANCE', 'BYBIT', 'KUCOIN', 'GATE', 'HTX', 'BITGET',
  'KRAKEN', 'COINBASE',
  // NOTE: "AI" was previously banned defensively (to avoid "Binance AI Conf"
  // style false matches). It's now a real OKX ticker (Gensyn = AI/USDT spot),
  // and the regex contexts that pick it up (TICKERUSDT / TICKER-USDT /
  // (TICKER) parens) are strong enough that bare-prose "AI" won't match.
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
  // Scan title + body — bulk listings sometimes put the full ticker list
  // in the title (e.g. Gate '将上线 DRAM (...) 、HIMS (...)、JPM (...)').
  const title = item.title || '';
  const body = title + '\n' + (item.body || '');
  const tokens = new Set();
  // Strip plain USD suffix too when the announcement is a USD-margined /
  // X-Perp contract — there the "USD" is the quote currency, not part of
  // the ticker. e.g. OKX X-Perp publishes "AVAXUSD、BCHUSD、TONUSD、ZECUSD",
  // but the underlying tickers are AVAX/BCH/TON/ZEC. Outside this context
  // we never strip plain USD (BUSD/TUSD/PYUSD/FDUSD are real stablecoin
  // tickers).
  const isUsdQuoted = /X-?Perp|X-?合[約约]|USD\s*本位|USD-?Margined|USDⓈ-?Margined/i.test(title);
  // Canonicalise: strip USDT/USDC suffix so a body that lists both 'BRKB'
  // and 'BRKBUSDT' as separate tracker-pair tickers doesn't show up as
  // two rows in the daily.
  const add = (t) => {
    if (!t || BANNED_TOKEN.has(t)) return;
    let canon = t.replace(/USD[TC]$/, '');
    if (isUsdQuoted && canon === t && t.length > 5 && t.endsWith('USD')) {
      canon = t.slice(0, -3);
    }
    if (canon && canon !== t && tokens.has(t)) tokens.delete(t);
    tokens.add(canon || t);
  };
  // Pattern 1: TICKERUSDT-Margined / TICKERUSDT 永續 / TICKERUSDT 永续
  //    Also handle 1000X / 10000X Bybit-style scaled perps. Lookbehind anchors
  //    the optional digit prefix at a word start.
  for (const m of body.matchAll(/(?<![A-Z0-9])(\d{3,5})?([A-Z][A-Z0-9]{1,14})USDT[-\s]?(?:Margined|Perpetual|永續|永续|合約|合约)/g)) {
    add((m[1] || '') + m[2]);
  }
  // Pattern 1b: TICKER/USDT or TICKER-USDT explicit pair (OKX stock-perp body
  //    spells each contract as "IBM/USDT", "NOK/USDT", "BE/USDT", etc.).
  //    Allow 2-char tickers like BE here — the /USDT context is strict enough
  //    to keep false matches out.
  for (const m of body.matchAll(/(?<![A-Z0-9])([A-Z][A-Z0-9]{1,14})[/-]USD[TC]?\b/g)) {
    add(m[1]);
  }
  // Pattern 2: enumeration "TICKER1, TICKER2 and TICKER3" (Binance Multiple TradFi style)
  for (const m of body.matchAll(/\b([A-Z][A-Z0-9]{2,14})\s*(?:[,]\s+|\s+(?:and|及|和)\s+)/g)) {
    add(m[1]);
  }
  // Pattern 3: bullet list "1. TICKER" or "• TICKER"
  for (const m of body.matchAll(/[•·\-]\s+([A-Z][A-Z0-9]{2,14})\b/g)) {
    add(m[1]);
  }
  // Pattern 4: colon-introduced 、/comma list like
  //   "新增支援資產：ATOM、EIGEN、ENS、GRT、INJ、JTO、JUP、LDO、MORPHO、PENDLE、POL、RENDER、TIA、UNI"
  // Match the run of tokens-with-separators, then pull each TICKER out of it.
  // Allow 2-char tickers (BE, GO, MO etc.) — the colon + 顿号 context is
  // strict enough to avoid junk matches.
  for (const m of body.matchAll(/[：:]\s*((?:[A-Z][A-Z0-9]{1,14}\s*[、,]\s*){2,}[A-Z][A-Z0-9]{1,14})/g)) {
    for (const inner of m[1].matchAll(/\b([A-Z][A-Z0-9]{1,14})\b/g)) {
      add(inner[1]);
    }
  }
  // Pattern 5: bare 顿号 / comma list anywhere (no colon required), at least
  //   3 uppercase tickers in a row. Catches OKX's
  //   'SOXL、NBIS、QCOM、CSCO 股票永續合約' enumeration in the title and
  //   'IBM、NOK、BE' where BE is a 2-letter ticker.
  for (const m of body.matchAll(/((?:[A-Z][A-Z0-9]{1,14}\s*[、,]\s*){2,}[A-Z][A-Z0-9]{1,14})/g)) {
    for (const inner of m[1].matchAll(/\b([A-Z][A-Z0-9]{1,14})\b/g)) {
      add(inner[1]);
    }
  }
  return [...tokens].sort();
}

// Returns an array of tokens for this item. Most items → [single token];
// bulk listings → multiple tokens parsed from body.
function extractTokens(item) {
  const title = item.title || '';
  // Priority A: title with 2+ (TICKER) parens. The parens ARE the canonical
  // ticker list — trust them and skip the body scan. Body context like
  // "trading GENIUS and OPG against BTC, USDT" or "buy with VISA, MasterCard"
  // would otherwise leak BTC/VISA into the listings bucket as if they were
  // newly listed tokens. Accept both ASCII () and Chinese fullwidth （）.
  const titleParens = [...title.matchAll(/[(（]([A-Z][A-Z0-9]{0,14})[)）]/g)]
    .map(m => m[1]).filter(t => !BANNED_TOKEN.has(t));
  if (titleParens.length >= 2) {
    return [...new Set(titleParens)];
  }
  // Priority B: title with 2+ TICKERUSDT in commas / 顿号 (KuCoin convention
  //   "Will List BBXUSDT, LUNRUSDT & NVOUSDT Stock Index ...") OR 2+ 顿号-
  //   separated bare tickers ("IBM、NOK、BE 股票永續合約"). Either way the
  //   title IS the authoritative list — body sidebars on KuCoin / OKX leak
  //   random crypto tickers (BTC / NEAR2026 / USDG etc.) into the bulk
  //   expansion otherwise.
  const titleUsdt = [...title.matchAll(/(?<![A-Z0-9])(\d{3,5})?([A-Z][A-Z0-9]{1,14})USDT\b/g)]
    .map(m => (m[1] || '') + m[2]).filter(t => !BANNED_TOKEN.has(t));
  if (titleUsdt.length >= 2) {
    // Strip the trailing USDT for cleaner display (BBXUSDT → BBX).
    return [...new Set(titleUsdt.map(t => t.replace(/USDT$/, '')))];
  }
  // Pull every ticker out of a 顿号 / comma run in the title (the bulk
  // detector in extractToken() captures only "ticker before next 顿号",
  // missing both the first and last — this collects them all).
  const titleDunRuns = [...title.matchAll(/(?:[A-Z][A-Z0-9]{1,14}\s*[、,]\s*){1,}[A-Z][A-Z0-9]{1,14}/g)];
  const titleDunhao = [];
  for (const run of titleDunRuns) {
    for (const inner of run[0].matchAll(/\b([A-Z][A-Z0-9]{1,14})\b/g)) {
      if (!BANNED_TOKEN.has(inner[1])) titleDunhao.push(inner[1]);
    }
  }
  if (titleDunhao.length >= 2) {
    return [...new Set(titleDunhao)];
  }
  let single = extractToken(item);
  // Strip a trailing USD quote suffix on single-token USD-margined / X-Perp
  // listings (OKX "SLXUSD X-合約" → SLX). Only in that context — never touch
  // real *USD stablecoin tickers (BUSD / TUSD / PYUSD / FDUSD).
  if (/X-?Perp|X-?合[約约]|USD\s*本位|USD-?Margined|USDⓈ-?Margined/i.test(title)
      && single.length > 4 && single.endsWith('USD') && !BANNED_TOKEN.has(single)) {
    single = single.slice(0, -3);
  }
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
  // 0. Bulk-listing phrases → "多个" (better than "?" for the UI). Forces
  //    extractTokens to scan body for the full enumerated list.
  if (/Multiple\s+(?:USD|TradFi|Perpetual|Stock|股票)|多個|多个|多種|多种|及另外\s*\d+\s*[種种項项]|and\s+\d+\s+(?:more|others?)/i.test(title)) {
    return '多个';
  }
  // 0a. Multiple (TICKER) parens in title (excluding banned/brand) → also bulk.
  //     e.g. Gate '...将上线 DRAM (...)、HIMS (...)、JPM (...)' — 4 tickers.
  //     Accept Chinese fullwidth parens （） too (Bitget uses these).
  const titleParens = [...title.matchAll(/[(（]([A-Z][A-Z0-9]{0,14})[)）]/g)]
    .map(m => m[1]).filter(t => !BANNED_TOKEN.has(t));
  if (titleParens.length >= 2) return '多个';
  // 0b. 顿号 / comma enumeration of UPPERCASE tickers in title → bulk.
  //     e.g. OKX 'SOXL、NBIS、QCOM、CSCO 股票永續合約' → 4 tickers, no parens.
  const dunhao = [...title.matchAll(/\b([A-Z][A-Z0-9]{2,14})(?=\s*[、,]\s*[A-Z][A-Z0-9]{2,14})/g)]
    .map(m => m[1]).filter(t => !BANNED_TOKEN.has(t));
  if (dunhao.length >= 1) return '多个';   // even one means there's >=2 in the run
  // 0b. "TradFi 股票上新" or any "TradFi" branded listing → TradFi (Bybit/Binance)
  if (/TradFi\s*(股票|stock)?/i.test(title) && !/USDT|USDC/.test(title)) {
    return 'TradFi';
  }
  // 1. TICKERUSDT (perpetual notation — strongest signal). Allow up to 15 chars.
  //    Also handle Bybit-style 1000X / 10000X scaled perps (e.g. 10000NEXUSDT
  //    means perp denominated in 10,000 NEX units). Use a lookbehind to anchor
  //    the optional digit prefix at a word start, since \b between digit and
  //    letter doesn't trigger (both are \w).
  const usdtAll = [...title.matchAll(/(?<![A-Z0-9])(\d{3,5})?([A-Z][A-Z0-9]{1,14})USDT\b/g)];
  for (const m of usdtAll) {
    const tok = (m[1] || '') + m[2];
    if (!BANNED_TOKEN.has(m[2])) return tok;
  }
  // 2. TICKER-USDT or TICKER/USDT
  const dashedAll = [...title.matchAll(/\b([A-Z][A-Z0-9]{1,14})[/-]USD[TC]?\b/g)];
  for (const m of dashedAll) if (!BANNED_TOKEN.has(m[1])) return m[1];
  // 3. "Name (TICKER)" — accept Chinese fullwidth parens too (Bitget uses these).
  const parens = [...title.matchAll(/[(（]([A-Z][A-Z0-9]{0,14})[)）]/g)];
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
  if (/股票指数|股票指數|stock index|stock-index|美股合約|美股合约|股票合約|股票合约|股票永續|股票永续/i.test(t)) return '美股合约';
  if (/perpetual|永续合约|永續合約|u\s*本位|usd[Ⓢ⒮]?-?margined|合約創新板塊|合约创新板块|X-?Perp|X-?合[約约]/i.test(t)) return '永续合约';
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
    // `loose` items carry an explicit LISTING date from the title (MEXC
    // "將於 6/2 上線"). The listing date is authoritative even when the
    // publish time is fuzzy, so accept today OR yesterday for these.
    if (parsed.loose) {
      return parsed.date === TODAY_CST || parsed.date === YESTERDAY_CST;
    }
    // Date-only resolution: accept only TODAY. YESTERDAY is too lenient —
    // half of yesterday was before the 18:00 cutoff, so items dated YESTERDAY
    // need time precision to pass.
    return parsed.date === TODAY_CST;
  }
  // No date detected: reject. Binance now has ISO timestamps via detail
  // API; missing date here means the item is truly undatable junk.
  return false;
}

// ---- denylist (drop noise rows) ------------------------------------------
// Includes "promotional / reward / lottery" patterns so things like
// 「百倍收益圍獵計畫第 3 期：50,000 USDT 獎勵」 don't end up in the daily.
// Note: 定投 (DCA / dollar-cost averaging) was previously in DENY, but
// "现货定投新增支持 X" is legit new-token-support news. Keep the deny list
// scoped to genuine noise (campaigns, lotteries, maintenance, delistings).
const DENY = /Trading Competition|AMA|Completes Integration|Alpha Will Remove|Competition|Campaign|Maintenance|系統維護|System Maintenance|Institutions and VIPs|Getting started|Announcements$|Latest announcements|Trading updates|手续费|手續費|下架|下线|下線|关于下线|關於下線|Delisting|Will Delist|盲盒派对|盲盒派對|研究院|战略合作|戰略合作|机构周报|機構周報|百倍|圍獵|围猎|獵計|計畫第\s*\d+\s*期|计划第\s*\d+\s*期|第\s*\d+\s*期[：:]|獎勵等您|奖励等您|盲盒|抽獎|抽奖|抽签|抽籤|更名|透明度报告|透明度報告|研究院|直播挖矿|直播挖礦|热币赛|熱幣賽|签启好运|簽啟好運|报名领|報名領|報名即|报名即|重磅福利|豪礼|豪禮|豪奖|豪獎|金条|金條|福利$|VIP 交易分红|VIP 交易分紅|Gate Live|每月瓜分|快訊|快讯|周报|週報|月报|月報|CandyDrop|闪兑幸运|閃兌幸運|中奖狂欢|中獎狂歡|期权上线|期權上線|期权产品|期權產品|空投\s*[一二三四五六七八九十百\d]+\s*期|空投[四五六七八九十]期|幸運轉盤|幸运转盘|陽光普照|阳光普照|老友季|老友福利|老友专属|老友專屬|交易大赛|交易大賽|交易赛|交易賽|打卡领|打卡領|打卡瓜分|回归得|回歸得|单人最高|單人最高|回归首单包赔|回歸首單包賠|每日打卡|零成本跟单|零成本跟單|跟单第\s*[一二三四五六七八九十\d]+\s*期|跟單第\s*[一二三四五六七八九十\d]+\s*期|见面礼|見面禮|活期理财|活期理財|理财福利|理財福利|新人特权|新人特權|首充\s*\d+%|首充\s*[一二三四五六七八九十百]+%|返现\b|返現\b|邀友|空投来袭|空投來襲|新人同领|新人同領|回归加送|回歸加送|瓜分\s*[\d,]+\s*[A-Z]{3,6}|质押上线|質押上線|份额拆分|份額拆分|份额合并|份額合併|恢复盘前交易|恢復盤前交易|首次下载|首次下載|新用户专属|新用戶專屬|交易結束|交易结束|交割安排|盘前交易.*结束|盤前交易.*結束|开户领|開戶領|豪华奖池|豪華獎池|开放时间确认|開放時間確認|交易开放时间|交易開放時間|资金费率|資金費率|首交赢|首交贏|交易回馈|交易回饋|质押挑战赛|質押挑戰賽|回归用户赢取|回歸用戶贏取|挑战赛|挑戰賽|杠杆新增\s*[A-Z]+\/|槓桿新增\s*[A-Z]+\/|杠杆.*交易对|槓桿.*交易對|Adds\s+\w+\/(?:AED|EUR|GBP|TRY|BRL|ARS|JPY|CNY|UAH|RUB|IDR|VND|NGN|ZAR|MXN|COP|PLN)\s+Spot|\/(?:AED|EUR|GBP|TRY|BRL|ARS|JPY|CNY|UAH|RUB|IDR|VND|NGN|ZAR|MXN|COP|PLN)\s+Spot Trading Pair/i;

// "首发上线" / "Will List" / "上币" — these are strong positive listing
// signals. When a title has one of these AND no HARD-noise marker (campaign,
// lottery), keep it even if the DENY pattern would otherwise match (e.g.
// MEXC's "首發上線：MEXC ... Airdrop+ 獎池" — 'Airdrop' is fine, '獎池' is
// noise on its own but here it's a bonus on a real listing).
const ALLOW_OVERRIDE = /首發上線|首发上线|首發上市|首发上市|Will\s+(?:List|Launch|Add)|新美股合約上線|新美股合约上线|World Premiere/i;
const HARD_NOISE = /Trading Competition|百倍|圍獵|围猎|獵計|計畫第\s*\d+\s*期|计划第\s*\d+\s*期|第\s*\d+\s*期[：:]|抽獎|抽奖|抽签|抽籤|盲盒|更名|透明度报告|透明度報告|研究院|直播挖矿|直播挖礦|签启好运|簽啟好運|報名領|报名领|報名即|报名即|Gate Live|CandyDrop|闪兑幸运|閃兌幸運|中奖狂欢|中獎狂歡|幸運轉盤|幸运转盘|陽光普照|阳光普照/i;

function isDenied(item) {
  const title = item.title || '';
  if (ALLOW_OVERRIDE.test(title) && !HARD_NOISE.test(title)) return false;
  return DENY.test(title);
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
    // If extractor couldn't find a real ticker at all, the item is almost
    // certainly noise that slipped past DENY (e.g. 'Gate 预测市场升级' style
    // product-update copy). Drop it rather than show '?' in the table.
    if (tokens.length === 1 && tokens[0] === '?') continue;
    const type = extractType(item);
    const baseDetail = makeDetail(item);
    for (const token of tokens) {
      const dedupKey = `${key}|${token}|${type}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      // For bulk-expanded entries, prepend the specific token so each row's
      // detail is self-explanatory (otherwise N rows would share identical text).
      const detail = tokens.length > 1
        ? `${token}（同公告含 ${tokens.length} 个标的）`
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
    if (tokens.length === 1 && tokens[0] === '?') continue;
    const type = extractType(item);
    const baseDetail = makeDetail(item);
    const t = item.title || '';
    for (const token of tokens) {
      const dedupKey = `binance|${token}|${type}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      const detail = tokens.length > 1
        ? `${token}（同公告含 ${tokens.length} 个标的）`
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
