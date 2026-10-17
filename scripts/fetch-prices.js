#!/usr/bin/env node
/**
 * Fetch prices for the crypto / RWA portfolio.
 *
 * Equities (+ BITQ benchmark): FMP API, same as agentic-portfolio.
 * Tokens (+ BTC/ETH benchmark): CoinGecko public API (no key needed).
 *
 * Modes:
 *   --intraday   Latest quote for today (hourly cron). Equities only during US market hours.
 *   (default)    Backfill daily closes since BASE_DATE.
 *
 * Env: FMP_API_KEY (required for equities). COINGECKO_API_KEY optional (demo key raises rate limits).
 * Usage: node scripts/fetch-prices.js [--intraday]
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "..", "data");
const OUT_FILE = resolve(DATA_DIR, "prices.json");
const PORT_FILE = resolve(DATA_DIR, "portfolio.json");

const INTRADAY = process.argv.includes("--intraday");
const FMP_KEY = process.env.FMP_API_KEY;
const CG_KEY = process.env.COINGECKO_API_KEY || "";

const portfolio = JSON.parse(readFileSync(PORT_FILE, "utf-8"));
const BASE_DATE = portfolio.asof;

// Universe from portfolio.json
const EQUITIES = Object.entries(portfolio.holdings).filter(([, h]) => h.type === "equity").map(([t]) => t);
const TOKENS = Object.entries(portfolio.holdings).filter(([, h]) => h.type === "token").map(([t, h]) => ({ ticker: t, id: h.coingecko }));
const EQ_BENCH = portfolio.baskets.equity.bench.id; // BITQ
const TOKEN_BENCH = { BTC: "bitcoin", ETH: "ethereum" };

const FMP_BASE = "https://fmp-v2.icu/stable";
const CG_BASE = "https://api.coingecko.com/api/v3";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJSON(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (res.status === 429) {
    await sleep(15000);
    const retry = await fetch(url, { headers });
    if (!retry.ok) throw new Error(`HTTP ${retry.status} for ${url}`);
    return retry.json();
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// ---------- Equities (FMP) ----------

async function fmpHistory(symbol, from = BASE_DATE) {
  const url = `${FMP_BASE}/historical-price-eod/full?symbol=${encodeURIComponent(symbol)}&from=${from}&apikey=${FMP_KEY}`;
  const data = await fetchJSON(url);
  const points = {};
  if (Array.isArray(data)) for (const d of data) if (d.date >= from) points[d.date] = d.close;
  return points;
}

async function fmpBatchQuote(symbols) {
  const url = `${FMP_BASE}/batch-quote?symbols=${symbols.join(",")}&apikey=${FMP_KEY}`;
  return fetchJSON(url);
}

function usMarketOpenNow() {
  // Approximate: Mon–Fri 13:30–21:00 UTC (covers EDT/EST without DST logic; cron is the real gate)
  const now = new Date();
  const dow = now.getUTCDay();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return dow >= 1 && dow <= 5 && mins >= 13 * 60 + 30 && mins <= 21 * 60;
}

// ---------- Tokens (CoinGecko) ----------

const cgHeaders = CG_KEY ? { "x-cg-demo-api-key": CG_KEY } : {};

function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Daily closes since BASE_DATE: last price point in each UTC day. */
async function cgHistory(id, from = BASE_DATE) {
  const fromTs = Math.floor(Date.parse(from + "T00:00:00Z") / 1000);
  const toTs = Math.floor(Date.now() / 1000);
  const url = `${CG_BASE}/coins/${id}/market_chart/range?vs_currency=usd&from=${fromTs}&to=${toTs}`;
  const data = await fetchJSON(url, cgHeaders);
  const points = {};
  for (const [ts, price] of data.prices || []) points[utcDate(ts)] = Math.round(price * 1e6) / 1e6; // later points overwrite → last of day
  // Today's partial day is intraday, keep it (will be refreshed by cron)
  return points;
}

async function cgSimplePrice(ids) {
  const url = `${CG_BASE}/simple/price?ids=${ids.join(",")}&vs_currencies=usd`;
  return fetchJSON(url, cgHeaders);
}

// ---------- Main ----------

async function main() {
  let existing = {};
  if (existsSync(OUT_FILE)) {
    try { existing = JSON.parse(readFileSync(OUT_FILE, "utf-8")).prices || {}; } catch { /* fresh */ }
  }
  const prices = { ...existing };
  const errors = [];
  const merge = (t, pts) => { prices[t] = { ...(prices[t] || {}), ...pts }; };
  const today = new Date().toISOString().slice(0, 10);

  const eqSymbols = [...EQUITIES, EQ_BENCH];
  const cgList = [...TOKENS, ...Object.entries(TOKEN_BENCH).map(([ticker, id]) => ({ ticker, id }))];

  if (INTRADAY) {
    console.log("Mode: intraday\n");

    if (FMP_KEY && usMarketOpenNow()) {
      try {
        console.log(`FMP batch quote: ${eqSymbols.join(", ")}`);
        const quotes = await fmpBatchQuote(eqSymbols);
        if (Array.isArray(quotes)) for (const q of quotes) if (q.price != null) merge(q.symbol, { [today]: q.price });
      } catch (e) { errors.push(`FMP batch: ${e.message}`); console.error(e.message); }
    } else {
      console.log(FMP_KEY ? "US market closed — skipping equities" : "No FMP_API_KEY — skipping equities");
    }

    try {
      console.log(`CoinGecko simple price: ${cgList.map((c) => c.id).join(", ")}`);
      const q = await cgSimplePrice(cgList.map((c) => c.id));
      for (const { ticker, id } of cgList) {
        const p = q[id]?.usd;
        if (p != null) merge(ticker, { [today]: p }); else errors.push(`${ticker}: no price for id "${id}"`);
      }
    } catch (e) { errors.push(`CoinGecko simple: ${e.message}`); console.error(e.message); }
  } else {
    console.log("Mode: historical backfill\n");

    if (FMP_KEY) {
      for (const sym of eqSymbols) {
        try { console.log(`FMP history ${sym}`); merge(sym, await fmpHistory(sym)); }
        catch (e) { errors.push(`${sym}: ${e.message}`); console.error(e.message); }
      }
    } else {
      console.log("No FMP_API_KEY — skipping equities");
    }

    for (const { ticker, id } of cgList) {
      try {
        console.log(`CoinGecko history ${ticker} (${id})`);
        merge(ticker, await cgHistory(id));
        await sleep(2500); // public API: ~30 req/min
      } catch (e) { errors.push(`${ticker} (${id}): ${e.message}`); console.error(e.message); }
    }
  }

  writeFileSync(OUT_FILE, JSON.stringify({ prices, updated: new Date().toISOString() }, null, 2));
  const n = Object.keys(prices).length;
  const dates = new Set(Object.values(prices).flatMap((m) => Object.keys(m))).size;
  console.log(`\nDone. ${n} series, ${dates} unique dates → ${OUT_FILE}`);
  if (errors.length) { console.error(`\n${errors.length} error(s):`); errors.forEach((e) => console.error("  - " + e)); process.exit(1); }
}

main();
