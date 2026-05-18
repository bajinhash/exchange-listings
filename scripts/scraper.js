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
  return articles;
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
  // OKX API (www.okx.com/v2/support/home/web) returns empty from GH Actions
  // data-center IPs (geo-block on cloud subnets). Browser-rendered web page
  // works fine — same pattern as KuCoin / Gate / Bitget / MEXC.
  const articles = [];
  try {
    // Try API first (fast, ~0.3s)
    let apiOk = false;
    try {
      const data = await fetchJson('https://www.okx.com/v2/support/home/web');
      const notices = data?.data?.notices || [];
      const cutoffMs = Date.now() - 3 * 24 * 3600 * 1000;
      for (const n of notices) {
        if (n.sectionSlug !== 'announcements-new-listings') continue;
        const ts = new Date(n.publishDate).getTime();
        if (!isNaN(ts) && ts < cutoffMs) continue;
        const pubDate = new Date(n.publishDate).toISOString().split('T')[0];
        articles.push({
          title: n.shareText || n.shareTitle || '',
          url: `https://www.okx.com${n.link}`,
          body: `Published: ${pubDate}`,
        });
      }
      apiOk = articles.length > 0;
    } catch (_) { /* fall through to DOM */ }

    if (!apiOk) {
      console.error('  OKX API empty/blocked — falling back to web DOM scrape');
      await page.goto('https://www.okx.com/help/section/announcements-new-listings', {
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

async function scrapeGateio(page) {
  // Gate.io spot listings + a probe of additional sections. Each section is
  // scraped, then we drop pages whose article-IDs look ancient (id < 50000
  // = pre-2025 noise from footer / related-links). Only "fresh" articles
  // survive across the dedupe pass.
  const SECTIONS = [
    'https://www.gate.com/zh/announcements/newspotlistings',
    'https://www.gate.com/zh/announcements/newperpetualcontract',
    'https://www.gate.com/zh/announcements/newcontractlistings',
    'https://www.gate.com/zh/announcements/pre-marketlistings',
  ];
  const articles = [];
  const seen = new Set();
  try {
    for (const sectionUrl of SECTIONS) {
      let sectionItems = [];
      try {
        const resp = await page.goto(sectionUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        const status = resp ? resp.status() : 0;
        if (status >= 400) {
          console.error(`  Gate.io section ${sectionUrl} → HTTP ${status}, skipping`);
          continue;
        }
        await page.waitForTimeout(2500);
        sectionItems = await page.$$eval('a[href*="/article/"]', links =>
          links.map(a => ({ title: a.textContent?.trim() || '', href: a.getAttribute('href') || '' }))
            .filter(i => i.title.length > 15)
        );
      } catch (navErr) {
        console.error(`  Gate.io section ${sectionUrl} nav error:`, navErr.message);
        continue;
      }

      // Sanity: if a section's TOP items are all old (id < 50000), the URL
      // probably 200'd but rendered an unrelated page — skip its links.
      const topIds = sectionItems.slice(0, 3).map(i => {
        const m = i.href.match(/article\/(\d+)/);
        return m ? parseInt(m[1]) : 0;
      });
      const looksFresh = topIds.some(id => id >= 50000);
      if (!looksFresh) {
        console.error(`  Gate.io section ${sectionUrl} top items look stale (${topIds.join(',')}); skipping`);
        continue;
      }

      for (const item of sectionItems) {
        const url = item.href.startsWith('http') ? item.href : `https://www.gate.com${item.href}`;
        const idMatch = url.match(/article\/(\d+)/);
        const id = idMatch ? idMatch[1] : url;
        // Drop ancient articles (< 50000 IDs = pre-2025) — typically footer noise
        if (idMatch && parseInt(id) < 50000) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        articles.push({ title: item.title, url, body: null });
        if (articles.length >= 15) break;
      }
      if (articles.length >= 15) break;
    }
    for (const a of articles.slice(0, 10)) {
      a.body = await fetchPageContent(page, a.url, 'article, main, .content');
    }
  } catch (e) {
    console.error('  Gate.io scrape error:', e.message);
  }
  return articles;
}

async function scrapeBitget(page) {
  const articles = [];
  try {
    await page.goto('https://www.bitget.com/zh-CN/support/sections/5955813039257', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const items = await page.$$eval('a[href*="/articles/"]', links =>
      links.map(a => {
        const dateEl = a.closest('[class]')?.querySelector('[class*="date"], [class*="time"], span:last-child');
        const dateText = dateEl?.textContent?.trim() || '';
        return { title: a.textContent?.trim() || '', href: a.getAttribute('href') || '', date: dateText };
      }).filter(i => i.title.length > 10)
    );

    for (const item of items.slice(0, 6)) {
      const url = item.href.startsWith('http') ? item.href : `https://www.bitget.com${item.href}`;
      const body = await fetchPageContent(page, url, 'article, main, [class*="article"]');
      articles.push({ title: item.title, url, body });
    }
  } catch (e) {
    console.error('  Bitget scrape error:', e.message);
  }
  return articles;
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
  fs.writeFileSync(outputPath, JSON.stringify(rawData, null, 2), 'utf-8');

  console.log(`\nRaw data saved to ${outputPath}`);
  const total = Object.values(rawData.exchanges).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`Total articles collected: ${total}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
