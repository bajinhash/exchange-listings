const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const TODAY = new Date().toISOString().split('T')[0];
const DATA_DIR = path.join(__dirname, '..', 'data');

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
      const res = await fetch('https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=48&pageNo=1&pageSize=10');
      const data = await res.json();
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
    const res = await fetch('https://www.okx.com/v2/support/home/web');
    const data = await res.json();
    const notices = data?.data?.notices || [];
    for (const n of notices) {
      if (n.sectionSlug !== 'announcements-new-listings') continue;
      const publishDate = new Date(n.publishDate).toISOString().split('T')[0];
      if (publishDate !== TODAY) continue;
      const url = `https://www.okx.com${n.link}`;
      articles.push({ title: n.shareText || n.shareTitle || '', url, body: null });
    }
    for (const a of articles) {
      const body = await fetchPageContent(page, a.url, 'article, main, .article-content');
      a.body = body;
    }
  } catch (e) {
    console.error('  OKX scrape error:', e.message);
  }
  return articles;
}

async function scrapeBybit(page) {
  const articles = [];
  try {
    const res = await fetch('https://api.bybit.com/v5/announcements/index?locale=zh-TW&type=new_crypto&limit=10');
    const data = await res.json();
    const list = data?.result?.list || [];

    for (const item of list) {
      const publishDate = new Date(parseInt(item.publishTime)).toISOString().split('T')[0];
      if (publishDate !== TODAY) continue;
      if (item.title.includes('Competition') || item.title.includes('Campaign')) continue;
      articles.push({ title: item.title, url: item.url || '', body: item.description || null });
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

async function main() {
  console.log(`Scraping exchange listings for ${TODAY}...`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  async function withNewPage(fn) {
    const p = await context.newPage();
    try { return await fn(p); } finally { await p.close(); }
  }

  console.log('\n--- Collecting announcements ---');

  console.log('  Binance...');
  const binanceArticles = await withNewPage(p => scrapeBinance(p));
  console.log(`    Found ${binanceArticles.length} articles`);

  console.log('  OKX...');
  const okxArticles = await withNewPage(p => scrapeOKX(p));
  console.log(`    Found ${okxArticles.length} articles`);

  console.log('  Bybit...');
  const bybitArticles = await withNewPage(p => scrapeBybit(p));
  console.log(`    Found ${bybitArticles.length} articles`);

  console.log('  KuCoin...');
  const kucoinArticles = await withNewPage(p => scrapeKuCoin(p));
  console.log(`    Found ${kucoinArticles.length} articles`);

  console.log('  Gate.io...');
  const gateioArticles = await withNewPage(p => scrapeGateio(p));
  console.log(`    Found ${gateioArticles.length} articles`);

  console.log('  Bitget...');
  const bitgetArticles = await withNewPage(p => scrapeBitget(p));
  console.log(`    Found ${bitgetArticles.length} articles`);

  console.log('  MEXC...');
  const mexcArticles = await withNewPage(p => scrapeMEXC(p));
  console.log(`    Found ${mexcArticles.length} articles`);

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
