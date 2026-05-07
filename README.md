# exchange-listings

> Daily new-listing announcements from 7 major crypto exchanges, scraped once a day and rendered as a static page.

A small, fast, no-framework project that watches what's getting listed on Binance, OKX, Bybit, KuCoin, Gate.io, Bitget, and MEXC. The scraper runs on a schedule, writes structured JSON into `data/`, and a vanilla-JS frontend lets you flip through dates.

## Live site

Once GitHub Pages is enabled in repo settings, the site will be live at:

> **https://bajinhash.github.io/exchange-listings/**

## How it works

```
   GitHub Actions (cron, 02:30 UTC daily)
                  │
                  ▼
   ┌────────────────────────────┐
   │  scripts/scraper.js        │   Playwright, headless Chromium
   │   ├ Binance — internal API │
   │   ├ OKX     — internal API │
   │   ├ Bybit   — public API   │
   │   ├ KuCoin  — DOM scrape   │
   │   ├ Gate.io — DOM scrape   │
   │   ├ Bitget  — DOM scrape   │
   │   └ MEXC    — DOM scrape   │
   └─────────────┬──────────────┘
                 │ writes data/raw-YYYY-MM-DD.json
                 ▼
   (manual or AI-assisted curation step)
                 │ produces data/YYYY-MM-DD.json
                 ▼
   ┌────────────────────────────┐
   │  index.html + app.js        │
   │   GitHub Pages, no build    │
   └────────────────────────────┘
```

### Scraping strategy

Where the exchange exposes a JSON endpoint, the scraper hits it directly — that's faster, cheaper, and less brittle than driving a browser. Where there's no API, Playwright loads the page, waits for network-idle, and reads the DOM. Each exchange runs in its own browser context so cookies and state don't leak between them. A short keyword denylist filters out promotions, AMAs, and delistings.

### Output schema

`data/YYYY-MM-DD.json`:

```json
{
  "date": "2026-05-07",
  "updatedAt": "2026-05-07T10:30:00.000Z",
  "exchanges": {
    "binance": { "listings": [...], "alpha": [...], "wallet": [...] },
    "okx":     { "listings": [...] },
    "bybit":   { "listings": [...] }
  }
}
```

Each entry: `{ token, type, detail, url }`.

## Running locally

```bash
npm install
npx playwright install chromium
npm run scrape
# writes data/raw-YYYY-MM-DD.json
```

Then open `index.html` directly, or serve the folder:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Automation

Two workflows under `.github/workflows/`:

| Workflow | Trigger | What it does |
|---|---|---|
| `scrape.yml` | daily 02:30 UTC + manual | runs the scraper, commits `data/raw-*.json`, uploads artifact |
| `deploy.yml` | push to `main` + manual | publishes the static site to GitHub Pages |

The cron schedule is set to ~10:30 Asia/Shanghai so a fresh raw file is ready before most exchanges' Asia trading hours.

## Credit

The scraping architecture and frontend layout are based on
[jessiiiess/exchange-listings](https://github.com/jessiiiess/exchange-listings).
This fork adds a daily cron workflow, manual-dispatch triggers on both
workflows, and an artifact upload step for inspecting raw scrapes from the
Actions tab.

## License

MIT
