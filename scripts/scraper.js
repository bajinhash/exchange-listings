// =============================================================================
// LOCALE POLICY
// =============================================================================
// Every exchange we DOM-scrape is hit via its Traditional Chinese (zh-TW /
// zh-hant) or Simplified Chinese (zh / zh-CN) site, NOT its English / SG /
// global locale. Reason: Chinese-locale sections regularly carry the most
// complete listing list for Asia-targeting exchanges. The OKX SG-vs-TW
// surprise (2026-05-19) cost us 4 stock-index perp listings invisibly —
// users only see what we pull, so we standardise on the locale with the
// most coverage and never let two locales of the same site diverge.
//
//   Binance  → BAPI (locale-neutral)                    no problem
//   OKX      → /zh-hant/help/section/announcements-new-listings
//   Bybit    → api zh-TW + announcements.bybit.com/zh-TW
//   KuCoin   → /announcement/new-listings (en — zh-tw locale is sparser:
//              10 articles in en vs 3 in zh-tw, so use whichever is more
//              complete; principle is "completeness > locale conformity")
//   Gate.io  → /zh/announcements/...   (simplified, has 4 sub-sections)
//   Bitget   → /zh-CN/support/sections/5955813039257
//   MEXC     → /zh-TW/announcements/new-listings
//
// Rule of thumb when adding a new exchange: try zh-TW/zh-hant first, but
// audit completeness against en. Use whichever returns the most listings.
// =============================================================================

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// We run at 22:30 UTC (06:30 Asia/Shanghai) — at that moment the CST date is
// already "tomorrow" relative to UTC. Naming the report file by CST date
// keeps it intuitive for the user (the briefing dated 5/14 covers everything
// announced from 5/13 00:00 CST to 5/14 06:30 CST).
const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;
const TODAY = new Date(Date.now() + SHANGHAI_OFFSET_MS).toISOString().split('T')[0];
const DATA_DIR = path.join(__dirname, '..', 'data');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Hardened fetch: 15s timeout + browser-like headers. Binance/OKX edges
// will hang a bare `fetch()` indefinitely as part of bot detection — this
// makes us fail fast so the Playwright fallback (or the next exchange) runs.
async function fetchJson(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || 15000);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: ctl.signal,
      headers: {
        'user-agent': UA,
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8',
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function fetchPageContent(page, url, selector) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2000);
    const content = await page.textContent(selector || 'main').catch(() => null);
    return content ? content.slice(0, 3000) : null;
  } catch (e) {
    return null;
  }
}

async function scrapeBinance(page) {
  const articles = [];
  try {
    let items = [];
    try {
      const data = await fetchJson('https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=48&pageNo=1&pageSize=10');
      const rawArticles = data?.data?.catalogs?.[0]?.articles || data?.data?.articles || [];
      items = rawArticles.map(a => ({
        title: a.title || '',
        url: `https://www.binance.com/en/support/announcement/${a.code || a.id || ''}`,
        code: a.code || a.id || '',
      }));
    } catch (e) {
      await page.goto('https://www.binance.com/en/support/announcement/list/48', { waitUntil: 'networkidle', timeout: 40000 });
      await page.waitForTimeout(5000);
      const links = await page.$$eval('a[href*="/support/announcement/"]', links =>
        links.map(a => ({ title: a.textContent?.trim() || '', href: a.getAttribute('href') || '' }))
          .filter(i => i.title.length > 10)
      );
      items = links.map(l => {
        const m = l.href.match(/announcement\/([a-f0-9]{32})/);
        return { title: l.title, url: `https://www.binance.com${l.href}`, code: m ? m[1] : '' };
      });
    }

    for (const item of items.slice(0, 8)) {
      if (!item.title) continue;
      if (item.title.includes('Trading Competition') || item.title.includes('AMA')) continue;
      if (item.title.includes('Completes Integration') || item.title.includes('Alpha Will Remove')) continue;
      // Prefer the detail API — returns publishDate + structured body that
      // unrolls bulk-listing schedules (e.g. "Multiple TradFi" → all tickers).
      // Falls back to Playwright DOM if API rejects.
      let body = null;
      if (item.code) {
        try {
          const dat = await fetchJson(
            `https://www.binance.com/bapi/composite/v1/public/cms/article/detail/query?articleCode=${item.code}`
          );
          const d = dat?.data;
          if (d) {
            const pubIso = d.publishDate ? new Date(d.publishDate).toISOString() : null;
            // d.body comes as a JSON-string (not pre-parsed object). Parse defensively.
            let bodyTree = d.body;
            if (typeof bodyTree === 'string') {
              try { bodyTree = JSON.parse(bodyTree); } catch (_) { bodyTree = null; }
            }
            const text = flattenBinanceBody(bodyTree).replace(/\s+/g, ' ').slice(0, 4000);
            body = pubIso ? `Published: ${pubIso}\n\n${text}` : text;
          }
        } catch (_) { /* fall through */ }
      }
      if (!body) {
        body = await fetchPageContent(page, item.url, 'article, main, .content');
      }
      articles.push({ title: item.title, url: item.url, body });
    }
  } catch (e) {
    console.error('  Binance scrape error:', e.message);
  }

  // Binance Alpha: two sources for the alpha bucket —
  // 1. The product-catalog API (rankType=20) with showNewTag flag.
  //    Catches tokens AFTER Binance officially adds them.
  // 2. @BinanceWallet Twitter via Nitter RSS, parsing
  //    'Binance Alpha (will be|is) the first platform to feature X (TICKER)'.
  //    Catches FORECASTS — tweets typically announce 6-12h before listing,
  //    which means we surface upcoming Alpha listings on the same daily
  //    briefing as competing exchanges' announcements.
  const alphaTickers = new Set();
  try {
    const alphaTokens = await fetchBinanceAlphaNew();
    for (const tk of alphaTokens) {
      const m = tk.title.match(/Binance Alpha 上线 ([A-Za-z0-9]+)/);
      if (m) alphaTickers.add(m[1].toUpperCase());
      articles.push(tk);
    }
    if (alphaTokens.length) console.error(`  Binance Alpha API: +${alphaTokens.length} new tokens`);
  } catch (e) {
    console.error('  Binance Alpha API fetch error:', e.message);
  }
  try {
    const alphaForecasts = await fetchBinanceAlphaTweetForecasts();
    let added = 0;
    for (const tk of alphaForecasts) {
      const m = tk.title.match(/Binance Alpha 上线 ([A-Za-z0-9]+)/);
      if (m && alphaTickers.has(m[1].toUpperCase())) continue;  // dedupe vs API path
      if (m) alphaTickers.add(m[1].toUpperCase());
      articles.push(tk);
      added++;
    }
    if (added) console.error(`  Binance Alpha tweets: +${added} forecast(s)`);
  } catch (e) {
    console.error('  Binance Alpha tweet fetch error:', e.message);
  }

  return articles;
}

// Parse @BinanceWallet RSS for forecasts of upcoming Alpha listings.
// Pattern: 'Binance Alpha (will be|is) the first platform to feature X (TICKER)'.
// Found in both original tweets and replies ('R to @BinanceWallet: ...').
async function fetchBinanceAlphaTweetForecasts() {
  // Try a couple of public Nitter instances. nitter.net is the most reliable
  // mirror in 2026; if it's down, the function returns [] silently and the
  // API path (showNewTag) still works.
  // Nitter mirrors come and go — try several. Order roughly by reliability
  // observed 2026-05-20.
  const MIRRORS = [
    'https://nitter.net/BinanceWallet/rss',
    'https://nitter.tiekoetter.com/BinanceWallet/rss',
    'https://nitter.privacydev.net/BinanceWallet/rss',
    'https://nitter.poast.org/BinanceWallet/rss',
    'https://nitter.kavin.rocks/BinanceWallet/rss',
    'https://nitter.unixfox.eu/BinanceWallet/rss',
  ];
  // Nitter is finicky about headers — minimal headers (just User-Agent +
  // Accept: application/rss+xml) cause it to return 200 with an empty body
  // (silent rate-limit / anti-scrape). Sending a full browser-like header
  // set unlocks the actual RSS feed.
  //
  // Tested 2026-05-20:
  //   minimal headers          → 200 + 0B  (broken)
  //   +Accept-Encoding identity → 200 + 0B  (broken)
  //   browser-like Accept+Lang → 200 + 28KB ✓
  //   curl-like UA             → 200 + 0B  (broken)
  const NITTER_HEADERS = {
    'user-agent': UA,
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-encoding': 'identity',
    'accept-language': 'en-US,en;q=0.9',
  };
  let xml = null;
  let usedMirror = null;
  for (const url of MIRRORS) {
    try {
      const res = await fetch(url, {
        headers: NITTER_HEADERS,
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const body = await res.text();
        const items = (body.match(/<item>/g) || []).length;
        if (body.length > 1000 && items > 0) {
          xml = body;
          usedMirror = url.split('/')[2];
          break;
        }
        // Log the actual diagnostics so we can fix Nitter detection
        console.error(`  Binance Alpha tweets: ${url.split('/')[2]} → HTTP 200 but body=${body.length}B items=${items}, skipping`);
        continue;
      }
      console.error(`  Binance Alpha tweets: ${url.split('/')[2]} → HTTP ${res.status}, skipping`);
    } catch (e) {
      console.error(`  Binance Alpha tweets: ${url.split('/')[2]} → ${e.message}`);
    }
  }
  if (!xml) {
    console.error('  Binance Alpha tweets: all Nitter mirrors failed');
    return [];
  }
  console.error(`  Binance Alpha tweets: using mirror ${usedMirror}`);

  const out = [];
  const cutoffMs = Date.now() - 36 * 3600 * 1000;   // tweets within past 36h
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  const stripTag = (s) => s ? s.replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';

  let m;
  const seenTicker = new Set();
  while ((m = itemRe.exec(xml)) !== null) {
    const itemXml = m[1];
    const tm = itemXml.match(/<title>([\s\S]*?)<\/title>/);
    const lm = itemXml.match(/<link>([\s\S]*?)<\/link>/);
    const pm = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    if (!tm) continue;
    const title = stripTag(tm[1]);
    const link  = stripTag(lm ? lm[1] : '');
    const pubMs = pm ? new Date(stripTag(pm[1])).getTime() : 0;
    if (pubMs && pubMs < cutoffMs) continue;

    // Catches 'Binance Alpha will be the first platform to feature Nexus (NEX)'
    // and replies 'R to @BinanceWallet: Binance Alpha is the first platform to feature ...'
    const fc = title.match(/Binance Alpha\s+(?:will be|is)\s+the first platform to feature\s+([^,()]+?)\s*\(([A-Z][A-Z0-9]{0,14})\)/i);
    if (!fc) continue;
    const fullName = fc[1].trim();
    const ticker   = fc[2].toUpperCase();
    if (seenTicker.has(ticker)) continue;
    seenTicker.add(ticker);

    out.push({
      title: `Binance Alpha 上线 ${ticker} (${fullName}) — @BinanceWallet 公告`,
      url: link.replace('nitter.net', 'x.com').replace(/#m$/, ''),
      body: `Published: ${pubMs ? new Date(pubMs).toISOString() : new Date().toISOString()}\n\nBinance Alpha 即将上线预告（Twitter @BinanceWallet）\nTweet: ${title.slice(0, 300)}`,
    });
  }
  return out;
}

// Fetch tokens currently flagged as 'new' on Binance Alpha. Returns shaped
// article-like objects ready to push into raw[binance].
async function fetchBinanceAlphaNew() {
  const res = await fetch(
    'https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/pulse/unified/rank/list',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept-Encoding': 'identity',
        'User-Agent': 'binance-web3/2.0 (scraper)',
      },
      body: JSON.stringify({ rankType: 20, period: 50, sortBy: 0, orderAsc: false, page: 1, size: 50 }),
      signal: AbortSignal.timeout(15000),
    }
  );
  if (!res.ok) return [];
  const data = await res.json();
  const tokens = data?.data?.tokens || [];
  const out = [];
  for (const t of tokens) {
    if (!t?.alphaInfo?.showNewTag) continue;
    const sym = t.symbol || '';
    const desc = t.alphaInfo?.cnDescription || t.alphaInfo?.enDescription || '';
    const ca = t.contractAddress || '';
    const chain = t.chainId || '';
    const chainPath = { '1': 'eth', '56': 'bsc', '8453': 'base', 'CT_501': 'sol' }[chain] || chain;
    out.push({
      title: `Binance Alpha 上线 ${sym}${desc ? ' - ' + desc.slice(0, 80) : ''}`,
      url: `https://www.binance.com/en/alpha/${chainPath}/${ca}`,
      body: `Published: ${new Date().toISOString()}\n\nBinance Alpha 新增代币\nContract: ${ca}\nChain: ${chain}\nDescription: ${desc}`,
    });
  }
  return out;
}

// Binance body comes back as a tree: {node:'root', child:[{node:'element', tag, child:[...]}]}.
// Flatten to plain text by recursive walk — captures both leaf text nodes
// and (importantly) the schedule list with each TICKERUSDT-Margined entry.
function flattenBinanceBody(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(flattenBinanceBody).join('');
  let out = '';
  if (node.text) out += node.text;
  if (node.child) out += flattenBinanceBody(node.child);
  // p / br / li / h1-h6 get a trailing newline so token regexes have boundaries
  if (/^(p|br|li|h[1-6]|div)$/i.test(node.tag || '')) out += '\n';
  return out;
}

async function scrapeOKX(page) {
  // Use OKX TW (zh-hant) site exclusively: their announcements-new-listings
  // section there includes BOTH spot AND perpetual/futures listings (e.g.
  // 'OKX to list perpetual futures for SOXL/NBIS/QCOM/CSCO equities' — one
  // article covering 4 tokens). The en/SG section only has spot, missing
  // the stock-index perp launches that hit ~4-5x a week.
  const articles = [];
  try {
    {
      await page.goto('https://www.okx.com/zh-hant/help/section/announcements-new-listings', {
        waitUntil: 'domcontentloaded', timeout: 30000
      });
      await page.waitForTimeout(3000);
      const items = await page.$$eval('a[href*="/help/"]', as =>
        as.map(a => ({
          title: a.textContent?.trim() || '',
          href: a.getAttribute('href') || '',
        }))
        // Real article URLs look like /help/okx-to-list-... or /help/okx-will-launch-...
        // Sidebar/nav URLs are /help/section/... or /help/category/... — drop those.
        .filter(i =>
          i.title.length > 12
          && i.href.includes('/help/')
          && !i.href.endsWith('/help/')
          && !/\/help\/(section|category|categories)\//.test(i.href)
        )
      );
      const seen = new Set();
      const pubRe = /(.*?)Published on ([A-Z][a-z]+ \d{1,2}, \d{4})/;
      for (const item of items) {
        if (seen.has(item.href)) continue;
        seen.add(item.href);
        if (/Competition|Campaign|fee|手续费/i.test(item.title)) continue;
        // Title often looks like "OKX to list X for spot tradingPublished on May 6, 2026"
        // Split into clean title + published date.
        let title = item.title;
        let pubDate = null;
        const m = title.match(pubRe);
        if (m) {
          title = m[1].trim();
          const d = new Date(m[2]);
          if (!isNaN(d)) pubDate = d.toISOString().split('T')[0];
        }
        const url = item.href.startsWith('http') ? item.href : `https://www.okx.com${item.href}`;
        articles.push({
          title,
          url,
          body: pubDate ? `Published: ${pubDate}` : null,
        });
        if (articles.length >= 12) break;
      }
    }

    // Fetch full body for first 8 if no body yet (gives formatter more context)
    for (const a of articles.slice(0, 8)) {
      if (a.body && a.body.startsWith('Published:') && !a.body.includes('\n')) {
        // We have publish date but no body content; fetch detail page and append
        const detail = await fetchPageContent(page, a.url, 'article, main, .article-content');
        if (detail) a.body = `${a.body}\n\n${detail}`;
      } else if (!a.body) {
        a.body = await fetchPageContent(page, a.url, 'article, main, .article-content');
      }
    }
  } catch (e) {
    console.error('  OKX scrape error:', e.message);
  }
  return articles;
}

async function scrapeBybit(page) {
  // api.bybit.com returns empty list from GH Actions data-center IPs (geo-
  // block). Playwright on announcements.bybit.com hits ERR_HTTP2_PROTOCOL_ERROR
  // (Chromium negotiates H2, Bybit's H2 implementation rejects).
  //
  // Workaround: Node fetch (HTTP/1.1 via undici) on the same page returns the
  // server-rendered HTML with the full article list embedded inside a
  // <script id="__NEXT_DATA__"> JSON blob. Path inside that JSON:
  //   props.pageProps.articleInitEntity.list[]
  // Each item carries {title, description, url, date_timestamp (seconds)}.
  const articles = [];
  try {
    let apiOk = false;
    try {
      const data = await fetchJson('https://api.bybit.com/v5/announcements/index?locale=zh-TW&type=new_crypto&limit=15');
      const list = data?.result?.list || [];
      const cutoffMs = Date.now() - 3 * 24 * 3600 * 1000;
      for (const item of list) {
        const ts = parseInt(item.publishTime);
        if (!isNaN(ts) && ts < cutoffMs) continue;
        if (/Competition|Campaign/i.test(item.title)) continue;
        const pubIso = new Date(ts).toISOString();  // full timestamp
        articles.push({
          title: item.title,
          url: item.url || '',
          body: `Published: ${pubIso}\n\n${item.description || ''}`,
        });
      }
      apiOk = articles.length > 0;
    } catch (_) { /* fall through */ }

    if (!apiOk) {
      console.error('  Bybit API empty/blocked — falling back to __NEXT_DATA__ on announcements page');
      const res = await fetch('https://announcements.bybit.com/zh-TW/?category=new_crypto', {
        headers: {
          'user-agent': UA,
          'accept': 'text/html,application/xhtml+xml',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`Bybit HTML HTTP ${res.status}`);
      const html = await res.text();
      const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]+?)<\/script>/);
      if (!m) throw new Error('Bybit __NEXT_DATA__ not found in HTML');
      const data = JSON.parse(m[1]);
      const list = data?.props?.pageProps?.articleInitEntity?.list || [];
      const cutoffMs = Date.now() - 3 * 24 * 3600 * 1000;
      for (const item of list) {
        const ts = (item.date_timestamp || 0) * 1000;
        if (ts && ts < cutoffMs) continue;
        const title = item.title || '';
        if (!title || /Competition|Campaign/i.test(title)) continue;
        const pubIso = new Date(ts).toISOString();  // full timestamp
        const url = (item.url || '').startsWith('http')
          ? item.url
          : `https://announcements.bybit.com/zh-TW${item.url || ''}`;
        articles.push({
          title,
          url,
          body: `Published: ${pubIso}\n\n${item.description || ''}`,
        });
        if (articles.length >= 15) break;
      }
    }
  } catch (e) {
    console.error('  Bybit scrape error:', e.message);
  }
  return articles;
}

async function scrapeKuCoin(page) {
  // KuCoin: use the no-prefix (en) URL — empirically gives ~10 articles
  // per fetch. /zh-tw/ and /zh-hant/ render with only ~3 visible items.
  // Per LOCALE POLICY: we DO want consistency, but only when the alternate
  // locale is at least as complete. For KuCoin, en IS the most complete.
  // (Tested 2026-05-19: en=10 vs zh-tw=3 articles.)
  const articles = [];
  try {
    await page.goto('https://www.kucoin.com/announcement/new-listings', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const items = await page.$$eval('a[href*="/announcement/"]', links =>
      links.map(a => ({ title: a.textContent?.trim() || '', href: a.getAttribute('href') || '' }))
        .filter(i => i.title.length > 15 && !i.href.includes('/announcement/new-listings'))
    );

    for (const item of items.slice(0, 10)) {
      const url = item.href.startsWith('http') ? item.href : `https://www.kucoin.com${item.href}`;
      const body = await fetchPageContent(page, url, 'article, main, .content');
      articles.push({ title: item.title, url, body });
    }
  } catch (e) {
    console.error('  KuCoin scrape error:', e.message);
  }
  return articles;
}

const GATEIO_SECTIONS = [
  'https://www.gate.com/zh/announcements/newspotlistings',
  'https://www.gate.com/zh/announcements/newperpetualcontract',
  'https://www.gate.com/zh/announcements/newcontractlistings',
  'https://www.gate.com/zh/announcements/pre-marketlistings',
];

// Walk each Gate.io section with the given page, filling `pool` (id -> {title,url}).
// Returns the count of sections that hard-403'd (Akamai bot block) so the
// caller can decide whether to retry with a non-headless browser.
async function gateioCollectSections(page, pool) {
  let http403 = 0;
  for (const sectionUrl of GATEIO_SECTIONS) {
    let sectionItems = [];
    try {
      const resp = await page.goto(sectionUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
      const status = resp ? resp.status() : 0;
      if (status >= 400) {
        if (status === 403) http403++;
        console.error(`  Gate.io ${sectionUrl} → HTTP ${status}, skipping`);
        continue;
      }
      await page.waitForTimeout(2500);
      // Akamai sometimes serves a JS challenge (200) that resolves into the
      // real content a beat later — wait for article links before reading.
      try { await page.waitForSelector('a[href*="/article/"]', { timeout: 6000 }); } catch {}
      sectionItems = await page.$$eval('a[href*="/article/"]', links =>
        links.map(a => ({ title: a.textContent?.trim() || '', href: a.getAttribute('href') || '' }))
          .filter(i => i.title.length > 15)
      );
    } catch (navErr) {
      console.error(`  Gate.io ${sectionUrl} nav error:`, navErr.message);
      continue;
    }

    // Sanity: top-3 of this section's links should include at least one
    // recent (id >= 50000) article; otherwise the URL likely rendered
    // an unrelated page and the links are footer noise.
    const topIds = sectionItems.slice(0, 3).map(i => {
      const m = i.href.match(/article\/(\d+)/);
      return m ? parseInt(m[1]) : 0;
    });
    const looksFresh = topIds.some(id => id >= 50000);
    if (!looksFresh) {
      console.error(`  Gate.io ${sectionUrl} top items stale (${topIds.join(',')}); skipping`);
      continue;
    }

    let addedFromSection = 0;
    for (const item of sectionItems) {
      const url = item.href.startsWith('http') ? item.href : `https://www.gate.com${item.href}`;
      const idMatch = url.match(/article\/(\d+)/);
      if (!idMatch) continue;
      const id = idMatch[1];
      if (parseInt(id) < 50000) continue;          // pre-2025 noise
      if (pool.has(id)) continue;
      pool.set(id, { title: item.title, url });
      addedFromSection++;
      if (addedFromSection >= 15) break;          // per-section cap
    }
    console.log(`  Gate.io ${sectionUrl.split('/').pop()}: +${addedFromSection} fresh`);
  }
  return http403;
}

// Sort the id->article pool newest-first and keep the top 30. Gate floods
// its listing sections with promo (creator incentives, prediction-market
// games, fee campaigns, grid-bot ads), which can crowd a genuine listing
// out of a smaller window — e.g. a 14:00 stock-perp launch buried under 6h
// of campaign posts. The formatter's DENY filters the promo afterwards, so
// keeping a wider pool here costs little and stops real listings dropping.
// Gate link text carries the relative time ("15 分钟前"), so dating works
// off the title even without a body fetch.
function gateioSortPool(pool) {
  return [...pool.values()]
    .sort((a, b) => {
      const ai = parseInt(a.url.match(/article\/(\d+)/)?.[1] || '0');
      const bi = parseInt(b.url.match(/article\/(\d+)/)?.[1] || '0');
      return bi - ai;
    })
    .slice(0, 30)
    .map(a => ({ ...a, body: null }));
}

// Fallback: when the shared HEADLESS browser gets hard-403'd by Akamai
// (happens when the egress IP — e.g. a flagged Clash proxy node — is on
// Akamai's headless-bot list), retry the whole Gate.io scrape with a
// dedicated NON-headless Chromium. A real rendered browser passes Akamai's
// sensor check where headless Chromium fails outright.
//
// Only ever fires locally: GH Actions' clean data-center IP gets a normal
// 200, so the primary path succeeds and this never runs there (which is
// good — headless:false needs a display GH Actions doesn't have). Wrapped
// so a launch failure degrades to [] instead of crashing the whole scrape.
async function scrapeGateioNonHeadless() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  let browser;
  try {
    browser = await chromium.launch({
      headless: false,
      ...(proxyUrl ? { proxy: { server: proxyUrl } } : {}),
    });
    const context = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      extraHTTPHeaders: { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = await context.newPage();
    const pool = new Map();
    await gateioCollectSections(page, pool);
    const articles = gateioSortPool(pool);
    for (const a of articles.slice(0, 10)) {
      a.body = await fetchPageContent(page, a.url, 'article, main, .content');
    }
    console.log(`  Gate.io non-headless fallback: ${articles.length} articles`);
    return articles;
  } catch (e) {
    console.error('  Gate.io non-headless fallback failed:', e.message);
    return [];
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function scrapeGateio(page) {
  // Gate.io publishes new-listing news across multiple sections. Scrape
  // each, collect all articles into one pool, dedupe by ID, sort by
  // article-ID desc (Gate IDs are monotonically increasing, so newest
  // first), then take the top 15. ID < 50000 = pre-2025 footer noise.
  const pool = new Map(); // id -> {title, url}
  try {
    const http403 = await gateioCollectSections(page, pool);

    // Headless got hard-403'd and collected nothing → retry non-headless.
    if (pool.size === 0 && http403 > 0) {
      console.error('  Gate.io: headless hard-403 from Akamai — retrying with non-headless browser');
      return await scrapeGateioNonHeadless();
    }

    const articles = gateioSortPool(pool);
    for (const a of articles.slice(0, 10)) {
      a.body = await fetchPageContent(page, a.url, 'article, main, .content');
    }
    return articles;
  } catch (e) {
    console.error('  Gate.io scrape error:', e.message);
    return gateioSortPool(pool);
  }
}

async function scrapeBitget(page) {
  // Bitget splits new-listing announcements across separate sections.
  // Reading only 现货 (spot) silently missed EVERY perp/futures listing
  // (QNTSTOCK pre-IPO conversions, SMR/SITM/BBSTOCK perps, the daily
  // TradFi-perp batches like NOW/IBM/NTAP) and every margin-pair add —
  // they live under the 合约 (contract) and 杠杆 (margin) sections.
  const SECTIONS = [
    { name: '现货', url: 'https://www.bitget.com/zh-CN/support/sections/5955813039257' },
    { name: '合约', url: 'https://www.bitget.com/zh-CN/support/sections/12508313405000' },
    { name: '杠杆', url: 'https://www.bitget.com/zh-CN/support/sections/12508313443168' },
  ];
  const seen = new Set();
  const candidates = [];
  try {
    for (const section of SECTIONS) {
      try {
        await page.goto(section.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);
        const items = await page.$$eval('a[href*="/articles/"]', links =>
          links.map(a => ({ title: a.textContent?.trim() || '', href: a.getAttribute('href') || '' }))
            .filter(i => i.title.length > 10)
        );
        let added = 0;
        for (const item of items) {
          const url = item.href.startsWith('http') ? item.href : `https://www.bitget.com${item.href}`;
          if (seen.has(url)) continue;
          seen.add(url);
          candidates.push({ title: item.title, url });
          if (++added >= 6) break;   // per-section cap
        }
        console.log(`  Bitget ${section.name}: +${added}`);
      } catch (navErr) {
        console.error(`  Bitget ${section.name} nav error:`, navErr.message);
      }
    }
    // Fetch bodies (carry the "YYYY-MM-DD HH:MM" publish date) for the
    // freshest candidates so basic-format can window-filter them. Cap at 18
    // (3 sections × 6) so no section is structurally dropped by the body cap.
    const articles = [];
    for (const c of candidates.slice(0, 18)) {
      const body = await fetchPageContent(page, c.url, 'article, main, [class*="article"]');
      articles.push({ title: c.title, url: c.url, body });
    }
    return articles;
  } catch (e) {
    console.error('  Bitget scrape error:', e.message);
    return candidates.slice(0, 18).map(c => ({ ...c, body: null }));
  }
}

async function scrapeMEXC(page) {
  const articles = [];
  try {
    await page.goto('https://www.mexc.com/zh-TW/announcements/new-listings', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(1000);

    const items = await page.$$eval('a[href*="/announcements/article/"]', links =>
      links.map(a => {
        const parent = a.closest('[class]');
        const timeEl = parent?.querySelector('time');
        return {
          title: a.textContent?.trim() || '',
          href: a.getAttribute('href') || '',
          time: timeEl?.textContent?.trim() || ''
        };
      }).filter(i => i.title.length > 10)
    );

    // Bumped to 15 (was 10) so we don't drop legit items just because the
    // top of the page has 2-3 ranked entries. Note: 定投 used to be in this
    // skip list but "現貨定投新增支持 X" IS legit new-token-support news —
    // basic-format's DENY pattern handles real noise (campaigns/lotteries).
    for (const item of items.slice(0, 15)) {
      if (item.title.includes('手續費') || item.title.includes('下架')) continue;
      const url = item.href.startsWith('http') ? item.href : `https://www.mexc.com${item.href}`;
      articles.push({ title: item.title, url, body: null });
    }

    for (const a of articles.slice(0, 12)) {
      const body = await fetchPageContent(page, a.url, 'article, main, [class*="article"]');
      a.body = body;
    }
  } catch (e) {
    console.error('  MEXC scrape error:', e.message);
  }
  return articles;
}

async function main() {
  console.log(`Scraping exchange listings for ${TODAY}...`);

  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (proxyUrl) console.log(`[scrape] Using proxy: ${proxyUrl}`);
  const browser = await chromium.launch({
    headless: true,
    ...(proxyUrl ? { proxy: { server: proxyUrl } } : {}),
  });
  // Stealth-ish context — full desktop viewport, locale, timezone, headers
  // so HTX/Cloudflare bot checks treat us more like a real Asia user.
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    extraHTTPHeaders: {
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  });
  // Mask `navigator.webdriver` — common Cloudflare bot signal.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  async function withNewPage(fn) {
    const p = await context.newPage();
    try { return await fn(p); } finally { await p.close(); }
  }

  console.log('\n--- Collecting announcements ---');

  async function run(name, fn) {
    process.stdout.write(`  ${name}...`);
    const t0 = Date.now();
    const arr = await withNewPage(fn);
    console.log(` ${arr.length} articles (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return arr;
  }

  const binanceArticles = await run('Binance', p => scrapeBinance(p));
  const okxArticles     = await run('OKX',     p => scrapeOKX(p));
  const bybitArticles   = await run('Bybit',   p => scrapeBybit(p));
  const kucoinArticles  = await run('KuCoin',  p => scrapeKuCoin(p));
  const gateioArticles  = await run('Gate.io', p => scrapeGateio(p));
  const bitgetArticles  = await run('Bitget',  p => scrapeBitget(p));
  const mexcArticles    = await run('MEXC',    p => scrapeMEXC(p));

  await browser.close();

  const rawData = {
    date: TODAY,
    exchanges: {
      binance: binanceArticles,
      okx: okxArticles,
      bybit: bybitArticles,
      kucoin: kucoinArticles,
      gateio: gateioArticles,
      bitget: bitgetArticles,
      mexc: mexcArticles
    }
  };

  const outputPath = path.join(DATA_DIR, `raw-${TODAY}.json`);
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // Merge-don't-clobber: runs are idempotent overwrites, but the runners
  // degrade differently — Gate 403s GH Actions' data-center IPs (and the
  // non-headless fallback needs a display GH lacks), while the Mac runner
  // has a residential IP where the fallback works. On 2026-06-09 a later
  // GH run wrote gateio=[] over launchd's 30 good Gate articles. If THIS
  // run got nothing for an exchange but today's existing raw file has
  // entries, keep the old ones — an empty result is a scrape failure
  // signal, never better than data we already had.
  if (fs.existsSync(outputPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
      for (const [ex, arr] of Object.entries(rawData.exchanges)) {
        const old = prev.exchanges?.[ex];
        if (arr.length === 0 && Array.isArray(old) && old.length > 0) {
          rawData.exchanges[ex] = old;
          console.log(`  ${ex}: this run got 0 — kept ${old.length} from earlier run today`);
        }
      }
    } catch { /* unreadable previous file — just overwrite */ }
  }

  fs.writeFileSync(outputPath, JSON.stringify(rawData, null, 2), 'utf-8');

  console.log(`\nRaw data saved to ${outputPath}`);
  const total = Object.values(rawData.exchanges).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`Total articles collected: ${total}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
