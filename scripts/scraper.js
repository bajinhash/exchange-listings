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
      }));
    } catch (e) {
      await page.goto('https://www.binance.com/en/support/announcement/list/48', { waitUntil: 'networkidle', timeout: 40000 });
      await page.waitForTimeout(5000);
      const links = await page.$$eval('a[href*="/support/announcement/"]', links =>
        links.map(a => ({ title: a.textContent?.trim() || '', href: a.getAttribute('href') || '' }))
          .filter(i => i.title.length > 10)
      );
      items = links.map(l => ({ title: l.title, url: `https://www.binance.com${l.href}` }));
    }

    for (const item of items.slice(0, 8)) {
      if (!item.title) continue;
      if (item.title.includes('Trading Competition') || item.title.includes('AMA')) continue;
      if (item.title.includes('Completes Integration') || item.title.includes('Alpha Will Remove')) continue;
      const body = await fetchPageContent(page, item.url, 'article, main, .content');
      articles.push({ title: item.title, url: item.url, body });
    }
  } catch (e) {
    console.error('  Binance scrape error:', e.message);
  }
  return articles;
}

async function scrapeOKX(page) {
  const articles = [];
  try {
    const data = await fetchJson('https://www.okx.com/v2/support/home/web');
    const notices = data?.data?.notices || [];
    // Keep new-listing-section items from past ~3 days; the formatter
    // narrows further to the 30.5h CST briefing window.
    const cutoffMs = Date.now() - 3 * 24 * 3600 * 1000;
    for (const n of notices) {
      if (n.sectionSlug !== 'announcements-new-listings') continue;
      const ts = new Date(n.publishDate).getTime();
      if (!isNaN(ts) && ts < cutoffMs) continue;
      const url = `https://www.okx.com${n.link}`;
      const pubDate = new Date(n.publishDate).toISOString().split('T')[0];
      articles.push({
        title: n.shareText || n.shareTitle || '',
        url,
        body: `Published: ${pubDate}`,
      });
    }
    // Hit detail pages in parallel-ish for fuller body content
    for (const a of articles.slice(0, 10)) {
      const body = await fetchPageContent(page, a.url, 'article, main, .article-content');
      if (body) a.body = `${a.body}\n\n${body}`;
    }
  } catch (e) {
    console.error('  OKX scrape error:', e.message);
  }
  return articles;
}

async function scrapeBybit(page) {
  const articles = [];
  try {
    const data = await fetchJson('https://api.bybit.com/v5/announcements/index?locale=zh-TW&type=new_crypto&limit=15');
    const list = data?.result?.list || [];
    // Keep items from past ~3 days; formatter narrows to CST briefing window.
    const cutoffMs = Date.now() - 3 * 24 * 3600 * 1000;
    for (const item of list) {
      const ts = parseInt(item.publishTime);
      if (!isNaN(ts) && ts < cutoffMs) continue;
      if (item.title.includes('Competition') || item.title.includes('Campaign')) continue;
      const pubDate = new Date(ts).toISOString().split('T')[0];
      articles.push({
        title: item.title,
        url: item.url || '',
        body: `Published: ${pubDate}\n\n${item.description || ''}`,
      });
    }
  } catch (e) {
    console.error('  Bybit API error:', e.message);
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
  const articles = [];
  try {
    await page.goto('https://www.gate.com/zh/announcements/newspotlistings', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const items = await page.$$eval('a[href*="/article/"]', links =>
      links.map(a => ({ title: a.textContent?.trim() || '', href: a.getAttribute('href') || '' }))
        .filter(i => i.title.length > 15)
    );

    for (const item of items.slice(0, 8)) {
      const url = item.href.startsWith('http') ? item.href : `https://www.gate.com${item.href}`;
      const body = await fetchPageContent(page, url, 'article, main, .content');
      articles.push({ title: item.title, url, body });
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

    for (const item of items.slice(0, 10)) {
      if (item.title.includes('定投') || item.title.includes('手續費') || item.title.includes('下架')) continue;
      const url = item.href.startsWith('http') ? item.href : `https://www.mexc.com${item.href}`;
      articles.push({ title: item.title, url, body: null });
    }

    for (const a of articles.slice(0, 8)) {
      const body = await fetchPageContent(page, a.url, 'article, main, [class*="article"]');
      a.body = body;
    }
  } catch (e) {
    console.error('  MEXC scrape error:', e.message);
  }
  return articles;
}

async function scrapeHTX(page) {
  // HTX (formerly Huobi) — new listings announcements.
  // The list page at /zh-cn/support/list/{categoryId} is server-rendered:
  // titles + IDs + dates are all in the initial HTML, no AJAX needed.
  // category 360000039942 = "新币上线" (New Listings), discovered via the
  // tabList in window.__NUXT__ on the support homepage.
  //
  // GH Actions IPs hit Cloudflare 403 on bare fetch — fall back to Playwright
  // (real Chromium TLS handshake passes their bot check). User local IP may
  // have either issue, so we try fetch first (fast), then Playwright (slow).
  const NEW_LISTING_CATEGORY = '360000039942';
  const LIST_URL = `https://www.htx.com/zh-cn/support/list/${NEW_LISTING_CATEGORY}`;
  // Row pattern: <a class="list-field1">TITLE</a> ... <div class="list-field3">MM/DD HH:MM</div>
  const rowRe = /<a[^>]*href="\/zh-cn\/support\/(\d{10,16})"[^>]*class="list-field1[^"]*"[^>]*>\s*([^<]+?)\s*<\/a>[\s\S]{0,400}?<div[^>]*class="list-field3"[^>]*>\s*([^<]+?)\s*<\/div>/g;

  function parseRows(html) {
    const out = [];
    let m;
    while ((m = rowRe.exec(html)) !== null) {
      const id = m[1];
      const title = m[2].trim();
      const dateText = m[3].trim();
      if (!title || title.length < 8) continue;
      if (/下架|暂停|维护|delisting/i.test(title)) continue;
      out.push({
        title,
        url: `https://www.htx.com/zh-cn/support/${id}`,
        body: `Published: ${dateText}`,
      });
    }
    return out.slice(0, 15);
  }

  const articles = [];
  try {
    // 1. fast path: plain fetch
    let html = null;
    try {
      const res = await fetch(LIST_URL, {
        headers: { 'user-agent': UA, 'accept': 'text/html,*/*' },
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        html = await res.text();
      } else {
        console.error(`  HTX fetch HTTP ${res.status} — falling back to Playwright`);
      }
    } catch (e) {
      console.error(`  HTX fetch error (${e.message}) — falling back to Playwright`);
    }

    // 2. fallback: Playwright (real-browser TLS fingerprint may bypass Cloudflare).
    // Don't wait for networkidle — Cloudflare's challenge page can keep XHR
    // pinging indefinitely. Instead: fast initial load, then poll for the
    // actual list anchor up to 25s (challenge typically clears in 5-8s).
    if (!html) {
      try {
        await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        const got = await page.waitForSelector('a.list-field1', { timeout: 25000 }).catch(() => null);
        if (!got) {
          console.error('  HTX list-field1 did not appear within 25s — Cloudflare likely blocking this IP');
        }
        await page.waitForTimeout(800);
        html = await page.content();
      } catch (e) {
        console.error('  HTX Playwright error:', e.message);
        return articles;
      }
    }

    const rows = parseRows(html);
    articles.push(...rows);
  } catch (e) {
    console.error('  HTX scrape error:', e.message);
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
  const htxArticles     = await run('HTX',     p => scrapeHTX(p));

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
      mexc: mexcArticles,
      htx: htxArticles
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
