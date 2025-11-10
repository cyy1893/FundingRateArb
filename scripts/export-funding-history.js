"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const HYPER_API = "https://api.hyperliquid.xyz/info";
const BINANCE_FUNDING_RATE_API = "https://fapi.binance.com/fapi/v1/fundingRate";
const BINANCE_EXCHANGE_INFO_API = "https://fapi.binance.com/fapi/v1/exchangeInfo";
const BINANCE_FUNDING_INFO_API = "https://fapi.binance.com/fapi/v1/fundingInfo";
const DEFAULT_BINANCE_FUNDING_PERIOD_HOURS = 8;
const BINANCE_ALLOWED_QUOTES = ["USDT"];
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (compatible; FundingRateExporter/1.0; +https://example.com)";
const BINANCE_FUNDING_LIMIT = 100;
const HOURS_PER_DAY = 24;
const MS_PER_HOUR = 60 * 60 * 1000;
const HISTORY_DAYS = 30;
const OUTPUT_DIR = path.join(process.cwd(), "data", "funding-history");
function normalizeTimestampToHour(ts) {
  return Math.floor(ts / MS_PER_HOUR) * MS_PER_HOUR;
}
async function fetchJson(url, init, attempt = 0) {
  const res = await fetch(url, init);
  if (res.status === 429 && attempt < 5) {
    const retryAfterHeader = res.headers.get("retry-after");
    const retryAfterMs = Number.isFinite(Number(retryAfterHeader))
      ? Number(retryAfterHeader) * 1000
      : 500 * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
    return fetchJson(url, init, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Request failed ${url} (${res.status}): ${text}`);
  }
  return res.json();
}
function withUserAgent(init = {}) {
  const headers = Object.assign({}, init.headers);
  if (!headers["User-Agent"] && !headers["user-agent"]) {
    headers["User-Agent"] = DEFAULT_USER_AGENT;
  }
  return { ...init, headers };
}
async function fetchBinanceJson(url, init) {
  return fetchJson(url, withUserAgent(init));
}
async function fetchHyperMeta() {
  const payload = {
    type: "metaAndAssetCtxs",
  };
  const res = await fetchJson(HYPER_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!Array.isArray(res) || res.length < 1) {
    throw new Error("Unexpected Hyperliquid meta response");
  }
  const meta = res[0];
  if (!meta?.universe) {
    throw new Error("Hyperliquid meta missing universe");
  }
  return meta.universe
    .filter((asset) => asset && !asset.isDelisted)
    .map((asset) => asset.name);
}
async function fetchBinanceUniverse() {
  const [exchangeInfo, fundingInfo] = await Promise.all([
    fetchBinanceJson(BINANCE_EXCHANGE_INFO_API),
    fetchBinanceJson(BINANCE_FUNDING_INFO_API).catch(() => []),
  ]);
  const fundingIntervalMap = {};
  if (Array.isArray(fundingInfo)) {
    for (const item of fundingInfo) {
      const interval = Number.parseFloat(item?.fundingIntervalHours);
      if (item?.symbol && Number.isFinite(interval) && interval > 0) {
        fundingIntervalMap[item.symbol] = interval;
      }
    }
  }
  const validSymbols = new Set();
  if (Array.isArray(exchangeInfo?.symbols)) {
    exchangeInfo.symbols.forEach((item) => {
      if (
        item?.contractType === "PERPETUAL" &&
        BINANCE_ALLOWED_QUOTES.includes(item?.quoteAsset ?? "") &&
        item?.symbol
      ) {
        validSymbols.add(item.symbol);
      }
    });
  }
  return { validSymbols, fundingIntervalMap };
}
async function fetchHyperHistory(symbol, startTime) {
  const payload = {
    type: "fundingHistory",
    coin: symbol,
    startTime,
  };
  const res = await fetchJson(HYPER_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!Array.isArray(res)) {
    return [];
  }
  return res
    .map((entry) => {
      const time = normalizeTimestampToHour(Number(entry?.time));
      const rate = Number.parseFloat(entry?.fundingRate);
      return Number.isFinite(time) && Number.isFinite(rate)
        ? { time, rate }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);
}
async function fetchBinanceHistory(symbol, startTime) {
  const paramsWithStart = new URLSearchParams({
    symbol,
    startTime: String(startTime),
    limit: String(BINANCE_FUNDING_LIMIT),
  });
  async function executeRequest(params) {
    return fetchBinanceJson(`${BINANCE_FUNDING_RATE_API}?${params.toString()}`);
  }
  let data;
  try {
    data = await executeRequest(paramsWithStart);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!String(message).includes("403")) {
      throw error;
    }
    const fallbackParams = new URLSearchParams({
      symbol,
      limit: String(BINANCE_FUNDING_LIMIT),
    });
    data = await executeRequest(fallbackParams);
  }
  if (!Array.isArray(data)) {
    return [];
  }
  return data
    .map((entry) => {
      const time = normalizeTimestampToHour(Number(entry?.fundingTime));
      const rate = Number.parseFloat(entry?.fundingRate);
      return Number.isFinite(time) && Number.isFinite(rate)
        ? { time, rate }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);
}
function buildHourlyDataset({
  hyperHistory,
  binanceHistory,
  binanceIntervalHours,
}) {
  if (!hyperHistory.length) {
    return [];
  }
  const intervalHours = Math.max(binanceIntervalHours ?? DEFAULT_BINANCE_FUNDING_PERIOD_HOURS, 1);
  const dataset = [];
  let binanceIndex = 0;
  let currentBinanceHourly = null;
  hyperHistory.forEach(({ time, rate }) => {
    while (
      binanceIndex < binanceHistory.length &&
      binanceHistory[binanceIndex].time <= time
    ) {
      const hourly = (binanceHistory[binanceIndex].rate / intervalHours) * 100;
      if (Number.isFinite(hourly)) {
        currentBinanceHourly = hourly;
      }
      binanceIndex += 1;
    }
    const hyperPercent = rate * 100;
    const binancePercent =
      typeof currentBinanceHourly === "number" ? currentBinanceHourly : null;
    dataset.push({
      time,
      hyperliquid: hyperPercent,
      binance: binancePercent,
      arbitrage:
        typeof binancePercent === "number" ? binancePercent - hyperPercent : null,
    });
  });
  return dataset;
}
function formatNumber(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "";
  }
  return Number(value).toFixed(6).replace(/\.?0+$/, "");
}
async function exportCsv(symbol, dataset) {
  if (!dataset.length) {
    console.log(`Skipping ${symbol}: no dataset`);
    return;
  }
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const lines = [
    "timestamp_iso,hyperliquid_percent,binance_percent,arbitrage_percent",
    ...dataset.map((row) =>
      [
        new Date(row.time).toISOString(),
        formatNumber(row.hyperliquid),
        formatNumber(row.binance),
        formatNumber(row.arbitrage),
      ].join(","),
    ),
  ];
  const filePath = path.join(OUTPUT_DIR, `${symbol}.csv`);
  await fs.writeFile(filePath, lines.join("\n"), "utf8");
  console.log(`Saved ${symbol} (${dataset.length} rows) -> ${filePath}`);
}
async function main() {
  const startTime = Date.now() - HISTORY_DAYS * HOURS_PER_DAY * MS_PER_HOUR;
  const [hyperSymbols, binanceMeta] = await Promise.all([
    fetchHyperMeta(),
    fetchBinanceUniverse(),
  ]);
  const { validSymbols, fundingIntervalMap } = binanceMeta;
  const intersections = hyperSymbols
    .map((symbol) => {
      const preferred = [`${symbol}USDC`, `${symbol}USDT`];
      const binanceSymbol = preferred.find((candidate) =>
        validSymbols.has(candidate),
      );
      return binanceSymbol ? { hyper: symbol, binance: binanceSymbol } : null;
    })
    .filter(Boolean);
  if (!intersections.length) {
    console.error("No overlapping symbols between Hyperliquid and Binance.");
    return;
  }
  console.log(`Found ${intersections.length} overlapping markets.`);
  const pending = [...intersections];
  const failures = [];
  async function processPair(pair, isRetry = false) {
    try {
      const [hyperHistory, binanceHistory] = await Promise.all([
        fetchHyperHistory(pair.hyper, startTime),
        fetchBinanceHistory(pair.binance, startTime),
      ]);
      const dataset = buildHourlyDataset({
        hyperHistory,
        binanceHistory,
        binanceIntervalHours: fundingIntervalMap[pair.binance],
      });
      await exportCsv(pair.hyper, dataset);
    } catch (error) {
      console.error(
        `Failed to export ${pair.hyper}${isRetry ? " (retry)" : ""}:`,
        error instanceof Error ? error.message : error,
      );
      if (!isRetry) {
        failures.push(pair);
      }
    }
    await delay(250);
  }
  for (const pair of pending) {
    await processPair(pair);
  }
  if (failures.length) {
    console.log(`Retrying ${failures.length} markets after backoff...`);
    await delay(3000);
    const retryQueue = [...failures];
    failures.length = 0;
    for (const pair of retryQueue) {
      await processPair(pair, true);
    }
  }
  console.log("Done.");
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}