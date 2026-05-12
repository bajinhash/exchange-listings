// AI formatter: read scripts/scraper.js output (data/raw-YYYY-MM-DD.json)
// → call Claude Opus 4.7 to extract structured listings per exchange
// → write data/YYYY-MM-DD.json for the frontend (app.js consumes this shape)
//
// Usage:
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/format.js          # today
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/format.js 2026-05-12

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk').default;

const DATE = process.argv[2] || new Date().toISOString().split('T')[0];
const DATA_DIR = path.join(__dirname, '..', 'data');
const RAW_PATH = path.join(DATA_DIR, `raw-${DATE}.json`);
const OUT_PATH = path.join(DATA_DIR, `${DATE}.json`);

// --- Schema the model must emit ---------------------------------------------
// listing item shape consumed by app.js renderTable():
//   { token, type, detail, url }
// Per-exchange shape consumed by app.js renderExchanges():
//   { listings: [...], alpha?: [...] (binance only), wallet?: [...] (binance only) }

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    binance: {
      type: 'object',
      properties: {
        listings: { type: 'array', items: { $ref: '#/$defs/listing' } },
        alpha:    { type: 'array', items: { $ref: '#/$defs/listing' } },
        wallet:   { type: 'array', items: { $ref: '#/$defs/listing' } },
      },
      required: ['listings', 'alpha', 'wallet'],
      additionalProperties: false,
    },
    okx:    { $ref: '#/$defs/exchange' },
    bybit:  { $ref: '#/$defs/exchange' },
    kucoin: { $ref: '#/$defs/exchange' },
    gateio: { $ref: '#/$defs/exchange' },
    bitget: { $ref: '#/$defs/exchange' },
    mexc:   { $ref: '#/$defs/exchange' },
    htx:    { $ref: '#/$defs/exchange' },
  },
  required: ['binance', 'okx', 'bybit', 'kucoin', 'gateio', 'bitget', 'mexc', 'htx'],
  additionalProperties: false,
  $defs: {
    listing: {
      type: 'object',
      properties: {
        token:  { type: 'string', description: '形如 "Billions Network (BILL)" 或 "BILL"' },
        type:   { type: 'string', description: '现货上线 / 永续合约 / 美股合约 / Alpha 上线 / Wallet 上线 等' },
        detail: { type: 'string', description: '时间、杠杆、交易对等关键信息，中文，1-2 句' },
        url:    { type: 'string', description: '原公告链接' },
      },
      required: ['token', 'type', 'detail', 'url'],
      additionalProperties: false,
    },
    exchange: {
      type: 'object',
      properties: {
        listings: { type: 'array', items: { $ref: '#/$defs/listing' } },
      },
      required: ['listings'],
      additionalProperties: false,
    },
  },
};

// --- Stable system prompt — sits before the per-day raw data ----------------
// Anything that changes day-to-day must come AFTER this in `messages` to
// preserve the cache prefix. See shared/prompt-caching.md.
const SYSTEM_PROMPT = `你是一个加密货币交易所新币上线公告的结构化抽取器。

输入：scraper.js 抓取的多家交易所 (Binance / OKX / Bybit / KuCoin / Gate.io / Bitget / MEXC / HTX) 公告原文 JSON。
输出：严格遵循输出 schema 的 JSON，按交易所组织，每条 listing 含 token / type / detail / url 四个字段。

== 抽取规则 ==

1. 只保留 **新币上线类**（现货上市、永续合约、美股合约代币化、Alpha 上线、Wallet 上线）。
   排除：交易竞赛、AMA、空投、定投、手续费调整、下架、暂停、维护、积分活动、合作公告。

2. **币种字段格式**："全名 (TICKER)"，例如 "Billions Network (BILL)"。
   只有 ticker 没有全名时，直接写 ticker；只有全名时，直接写全名。

3. **类型字段**（统一中文）：
   - "现货上线" / "现货上市"
   - "永续合约" / "U本位永续" / "币本位永续"
   - "美股合约"（美股代币化永续，如 ANTHROPIC-USDT-SWAP / QQQUSDT）
   - "杠杆上线" / "杠杆代币"
   - "Alpha 上线"（Binance Alpha 专属）
   - "Wallet 上线"（Binance Wallet 专属）
   - "Earn / Launchpool / Launchpad"
   - 其他用 1-4 字中文概括

4. **detail 字段**：中文 1-2 句，包含交易对、时间（UTC+8）、杠杆倍数等关键信息。
   例如："BILLUSDT 永续合约上线，最高 75 倍杠杆，2026-05-12 15:00 UTC+8"。

5. **Binance 特殊三栏**：
   - listings: 币安主站上币（现货/合约/杠杆）
   - alpha: Binance Alpha 平台上币
   - wallet: Binance Wallet 上币
   原始数据可能没有明确分类，根据 title/body 关键词判断：
     标题含 "Alpha" → alpha
     标题含 "Wallet" → wallet
     其余 → listings

6. **HTX 注意**：HTX 公告可能为中文原文，type/detail 直接整理为干净中文。

7. **当某交易所当天无新币上线**：返回 \`{"listings": []}\`（Binance 返回 \`{"listings": [], "alpha": [], "wallet": []}\`），不要省略字段。

8. **不要编造**：所有字段必须来源于原文。原文模糊就给保守描述，缺失就用空字符串占位（但 token 不能空）。

9. **去重**：同一币种同一类型在同一交易所只保留一条（合约 + 现货同时上线算两条）。

只输出 JSON，不要解释。`;

async function main() {
  if (!fs.existsSync(RAW_PATH)) {
    console.error(`[format] Raw file not found: ${RAW_PATH}`);
    console.error(`        Run \`npm run scrape\` first, or pass an existing date as argv.`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(RAW_PATH, 'utf-8'));
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('[format] ANTHROPIC_API_KEY missing — set it in env (locally or as a GH Actions secret).');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });

  console.log(`[format] Date: ${DATE}`);
  console.log(`[format] Raw articles total: ${Object.values(raw.exchanges).reduce((s, a) => s + a.length, 0)}`);
  console.log(`[format] Calling Claude Opus 4.7 (adaptive thinking, streaming, prompt cache)...`);

  // Stream because Opus 4.7 + adaptive thinking can produce long output before
  // the first token; non-streaming risks SDK HTTP timeout on large days.
  // Top-level cache_control auto-caches the last cacheable block — here that's
  // the system prompt, which is the stable prefix we want to reuse across days.
  const stream = client.messages.stream({
    model: 'claude-opus-4-7',
    max_tokens: 32000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
    },
    cache_control: { type: 'ephemeral' },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `日期: ${DATE}\n\n原始抓取数据 (raw JSON):\n\n${JSON.stringify(raw.exchanges, null, 2)}`,
      },
    ],
  });

  // surface progress so long days don't look hung
  let lastDot = Date.now();
  stream.on('text', () => {
    if (Date.now() - lastDot > 800) { process.stdout.write('.'); lastDot = Date.now(); }
  });

  const finalMessage = await stream.finalMessage();
  process.stdout.write('\n');

  // Find the JSON text block. With output_config.format set, Claude emits
  // a single text block whose body is the schema-conforming JSON.
  const textBlock = finalMessage.content.find(b => b.type === 'text');
  if (!textBlock) {
    console.error('[format] No text block in response. Dumping raw response:');
    console.error(JSON.stringify(finalMessage, null, 2));
    process.exit(2);
  }

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (e) {
    console.error('[format] JSON parse failed:', e.message);
    console.error('Raw text was:\n', textBlock.text.slice(0, 2000));
    process.exit(2);
  }

  // Ensure Binance has the three-bucket shape even if model skipped a field.
  parsed.binance = parsed.binance || {};
  parsed.binance.listings = parsed.binance.listings || [];
  parsed.binance.alpha    = parsed.binance.alpha    || [];
  parsed.binance.wallet   = parsed.binance.wallet   || [];

  const output = {
    date: DATE,
    updatedAt: new Date().toISOString(),
    exchanges: parsed,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2), 'utf-8');

  const counts = Object.entries(parsed).map(([k, v]) => {
    const n = (v.listings?.length || 0) + (v.alpha?.length || 0) + (v.wallet?.length || 0);
    return `${k}=${n}`;
  }).join('  ');
  console.log(`[format] Wrote ${OUT_PATH}`);
  console.log(`[format] Counts: ${counts}`);

  const u = finalMessage.usage || {};
  console.log(`[format] Tokens: input=${u.input_tokens} cache_read=${u.cache_read_input_tokens || 0} cache_write=${u.cache_creation_input_tokens || 0} output=${u.output_tokens}`);
}

main().catch(e => {
  console.error('[format] Fatal:', e);
  process.exit(1);
});
