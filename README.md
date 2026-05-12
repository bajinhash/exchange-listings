# exchange-listings

> Daily new-listing announcements from **8** major crypto exchanges (incl. HTX), scraped + AI-formatted on a cron and rendered as a static page.

A small, fast, no-framework project that watches what's getting listed on Binance, OKX, Bybit, KuCoin, Gate.io, Bitget, MEXC, and **HTX**. A scraper hits each exchange (API where available, Playwright DOM where not), Claude Opus 4.7 turns the raw HTML/JSON into a clean `{token, type, detail, url}` schema, and a vanilla-JS frontend lets you flip through dates.

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
   │   ├ HTX     — internal API │
   │   ├ KuCoin  — DOM scrape   │
   │   ├ Gate.io — DOM scrape   │
   │   ├ Bitget  — DOM scrape   │
   │   └ MEXC    — DOM scrape   │
   └─────────────┬──────────────┘
                 │ writes data/raw-YYYY-MM-DD.json
                 ▼
   ┌────────────────────────────┐
   │  scripts/format.js         │   Claude Opus 4.7
   │   adaptive thinking +      │   structured outputs (json_schema)
   │   streaming + prompt cache │   stable system prompt
   └─────────────┬──────────────┘
                 │ writes data/YYYY-MM-DD.json
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
npm run scrape                          # raw → data/raw-YYYY-MM-DD.json
ANTHROPIC_API_KEY=sk-ant-... npm run format   # raw → data/YYYY-MM-DD.json
# or in one shot:
ANTHROPIC_API_KEY=sk-ant-... npm run daily
```

Then open `index.html` directly, or serve the folder:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## AI formatter notes

`scripts/format.js` uses Claude Opus 4.7 with:

- **Adaptive thinking** — model decides reasoning depth per day
- **Structured outputs** (`output_config.format: json_schema`) — guarantees the `{token, type, detail, url}` shape and Binance's three-bucket split (listings / alpha / wallet)
- **Streaming + `finalMessage()`** — avoids HTTP timeout on busy days
- **Prompt caching** on the system prompt (`cache_control: {type: "ephemeral"}`) — every subsequent day reads ~90 % of the prefix from cache

Filter rules baked into the prompt: keep new-listing announcements (spot / perp / futures / Alpha / Wallet / US-stock perps); drop promotions, AMAs, fee changes, delistings, maintenance. Binance is split into `listings` / `alpha` / `wallet` automatically.

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
