import { NextResponse } from "next/server";

import type { FundingHistoryPoint } from "@/types/funding";

const DEFAULT_BINANCE_FUNDING_PERIOD_HOURS = 8;
const MS_PER_HOUR = 60 * 60 * 1000;
const MAX_HYPER_FUNDING_POINTS = 500;
const MAX_HYPER_LOOKBACK_MS = MAX_HYPER_FUNDING_POINTS * MS_PER_HOUR;

type Payload = {
  symbol?: string;
  binanceSymbol?: string | null;
  days?: number;
  binanceFundingPeriodHours?: number | null;
};

function normalizeTimestampToHour(value: number): number {
  return Math.floor(value / MS_PER_HOUR) * MS_PER_HOUR;
}

async function fetchHyperliquidFundingHistorySeries(
  symbol: string,
  startTime: number,
): Promise<Array<{ time: number; rate: number }>> {
  const response = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "fundingHistory",
      coin: symbol,
      startTime,
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error("Hyperliquid funding history request failed.");
  }

  const data = (await response.json()) as Array<{
    time: number;
    fundingRate: string;
  }>;

  return data
    .map((entry) => {
      const time = normalizeTimestampToHour(entry.time);
      const rate = Number.parseFloat(entry.fundingRate);
      return Number.isFinite(rate) ? { time, rate } : null;
    })
    .filter((point): point is { time: number; rate: number } => point !== null);
}

async function fetchBinanceFundingHistorySeries(
  symbol: string,
  startTime: number,
): Promise<Array<{ time: number; rate: number }>> {
  const params = new URLSearchParams({
    symbol,
    limit: "1000",
  });
  if (Number.isFinite(startTime)) {
    params.set("startTime", `${startTime}`);
  }

  const response = await fetch(
    `https://fapi.binance.com/fapi/v1/fundingRate?${params.toString()}`,
    {
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new Error("Binance funding history request failed.");
  }

  const data = (await response.json()) as Array<{
    fundingRate: string;
    fundingTime: number;
  }>;

  return data
    .map((entry) => {
      const time = normalizeTimestampToHour(entry.fundingTime);
      const rate = Number.parseFloat(entry.fundingRate);
      return Number.isFinite(rate) ? { time, rate } : null;
    })
    .filter((point): point is { time: number; rate: number } => point !== null);
}

async function buildFundingHistoryDataset(
  symbol: string,
  binanceSymbol: string | null,
  days: number,
  binanceFundingPeriodHours: number | null,
): Promise<FundingHistoryPoint[]> {
  const now = Date.now();
  const desiredStart = now - Math.max(days, 1) * 24 * MS_PER_HOUR;
  const latestAllowedStart = now - MAX_HYPER_LOOKBACK_MS;
  const startTime = Math.max(desiredStart, latestAllowedStart);

  const [hyperHistory, binanceHistory] = await Promise.all([
    fetchHyperliquidFundingHistorySeries(symbol, startTime).catch(() => []),
    binanceSymbol
      ? fetchBinanceFundingHistorySeries(binanceSymbol, startTime).catch(() => [])
      : Promise.resolve([]),
  ]);

  if (hyperHistory.length === 0 && binanceHistory.length === 0) {
    throw new Error("暂无可用的资金费率历史数据");
  }

  const sortedHyper = [...hyperHistory].sort((a, b) => a.time - b.time);
  const sortedBinance = [...binanceHistory].sort((a, b) => a.time - b.time);
  const intervalHours = Math.max(
    binanceFundingPeriodHours ?? DEFAULT_BINANCE_FUNDING_PERIOD_HOURS,
    1,
  );

  if (sortedHyper.length === 0) {
    return sortedBinance
      .map(({ time, rate }) => ({
        time,
        hyperliquid: null,
        binance: (rate / intervalHours) * 100,
        arbitrage: null,
      }))
      .sort((a, b) => a.time - b.time);
  }

  const dataset: FundingHistoryPoint[] = [];
  let binanceIndex = 0;
  let currentBinanceHourly: number | null = null;

  sortedHyper.forEach(({ time, rate }) => {
    while (
      binanceIndex < sortedBinance.length &&
      sortedBinance[binanceIndex].time <= time
    ) {
      const hourly = (sortedBinance[binanceIndex].rate / intervalHours) * 100;
      if (Number.isFinite(hourly)) {
        currentBinanceHourly = hourly;
      }
      binanceIndex += 1;
    }

    const hyperValue = rate * 100;
    const binanceValue = currentBinanceHourly;

    dataset.push({
      time,
      hyperliquid: hyperValue,
      binance: binanceValue,
      arbitrage:
        typeof binanceValue === "number" ? binanceValue - hyperValue : null,
    });
  });

  return dataset;
}

export async function POST(request: Request) {
  let payload: Payload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON payload" },
      { status: 400 },
    );
  }

  const symbol = typeof payload.symbol === "string" ? payload.symbol : "";
  if (!symbol) {
    return NextResponse.json(
      { error: "Symbol is required" },
      { status: 400 },
    );
  }

  const days =
    typeof payload.days === "number" && Number.isFinite(payload.days)
      ? payload.days
      : 7;

  const binanceSymbol =
    typeof payload.binanceSymbol === "string" ? payload.binanceSymbol : null;
  const binanceFundingPeriodHours =
    typeof payload.binanceFundingPeriodHours === "number"
      ? payload.binanceFundingPeriodHours
      : null;

  try {
    const dataset = await buildFundingHistoryDataset(
      symbol,
      binanceSymbol,
      days,
      binanceFundingPeriodHours,
    );

    return NextResponse.json({ dataset });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to load funding history.",
      },
      { status: 500 },
    );
  }
}
