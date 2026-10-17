# David's RWA Portfolio

Thematic portfolio built from Citrini Research, *Breaking The Wall* (2026-10-08). Same architecture as `agentic-portfolio`: static `index.html`, holdings in `data/portfolio.json`, prices in `data/prices.json` refreshed by a GitHub Action.

## Composition (inception 2026-10-08)

- **Equity basket** (vs BITQ): SECZ 22%, COIN 20%, FIGR 16%, CRCL 14%, BLSH 14%, HOOD 14%
- **Token basket** (vs 50:50 BTC/ETH): LIT 30%, DRV 25%, SYRUP 25%, AERO 20%
- **Combined** = 50% equity basket + 50% token basket, daily rebalanced

## Setup

1. Create a GitHub repo, push this folder.
2. Secrets → `FMP_API_KEY` (same as agentic-portfolio). `COINGECKO_API_KEY` is optional (demo key, higher rate limit).
3. Actions → *Update Prices* → *Run workflow* once (default mode = full backfill since inception).
4. Deploy on Vercel as a static site (no build step, output = repo root).

## Data

- Equities + BITQ: FMP (`historical-price-eod/full`, `batch-quote`), US market hours only.
- Tokens + BTC/ETH: CoinGecko public API (`/coins/{id}/market_chart/range`, `/simple/price`). IDs in `portfolio.json` → `holdings.*.coingecko`.
- Hourly intraday refresh (tokens every hour, equities only when the market is open); daily backfills at 22:40 UTC (US close) and 00:20 UTC (token daily close).

## Changing positions

Append to `log` in `portfolio.json`:

```json
{ "date": "2026-11-01", "basket": "token", "ticker": "LIT", "from": 0.30, "to": 0.25, "note": "...", "note_en": "..." }
```

Weights are within-basket. Changes take effect from the logged date.
