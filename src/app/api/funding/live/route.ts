import { NextResponse } from "next/server";

import { DEFAULT_FUNDING_PERIOD_HOURS } from "@/lib/funding";

type HyperliquidFundingResponse = [
  {
    universe: Array<{
      name: string;
    }>;
  },
  Array<{
    funding: string;
  }>,
];

type Payload = {
  hyperSymbols?: string[];
  binanceSymbols?: string[];
};

async function fetchHyperliquidFundingRates(
  symbols: string[],
): Promise<Record<string, number>> {
  if (symbols.length === 0) {
    return {};
  }

  const response = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
    cache: "no-store",
  });

  if (!response.ok) {
    return {};
  }

  const data = (await response.json()) as unknown;
  if (!Array.isArray(data) || data.length < 2) {
    return {};
  }

  const [meta, contexts] = data as HyperliquidFundingResponse;
  const targetSymbols = new Set(symbols.map((symbol) => symbol.toUpperCase()));

  const funding: Record<string, number> = {};
  meta.universe.forEach((asset, index) => {
    if (!targetSymbols.has(asset.name)) {
      return;
    }

    const rawFunding = contexts[index]?.funding;
    const parsed = Number.parseFloat(rawFunding ?? "");
    if (Number.isFinite(parsed)) {
      funding[asset.name] = parsed;
    }
  });

  return funding;
}

async function fetchBinanceFundingRates(
  symbols: string[],
): Promise<Record<string, number>> {
  if (symbols.length === 0) {
    return {};
  }

  const [premiumRes, fundingInfoRes] = await Promise.all([
    fetch("https://fapi.binance.com/fapi/v1/premiumIndex", {
      cache: "no-store",
    }),
    fetch("https://fapi.binance.com/fapi/v1/fundingInfo", {
      cache: "no-store",
    }),
  ]);

  if (!premiumRes.ok) {
    return {};
  }

  const data = (await premiumRes.json()) as Array<{
    symbol: string;
    lastFundingRate: string;
  }>;

  const targetSymbols = new Set(symbols);
  const funding: Record<string, number> = {};
  const intervalMap: Record<string, number> = {};

  if (fundingInfoRes.ok) {
    const fundingInfo = (await fundingInfoRes.json()) as Array<{
      symbol: string;
      fundingIntervalHours?: number | string;
    }>;

    fundingInfo?.forEach((item) => {
      if (!targetSymbols.has(item.symbol)) {
        return;
      }

      const hours =
        typeof item.fundingIntervalHours === "string"
          ? Number.parseInt(item.fundingIntervalHours, 10)
          : item.fundingIntervalHours;
      if (hours != null && Number.isFinite(hours)) {
        intervalMap[item.symbol] = hours;
      }
    });
  }

  data.forEach((item) => {
    if (!targetSymbols.has(item.symbol)) {
      return;
    }

    const parsed = Number.parseFloat(item.lastFundingRate);
    if (Number.isFinite(parsed)) {
      const intervalHours = intervalMap[item.symbol] ?? DEFAULT_FUNDING_PERIOD_HOURS;
      funding[item.symbol] = parsed / Math.max(intervalHours, 1);
    }
  });

  return funding;
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

  const hyperSymbols = Array.isArray(payload.hyperSymbols)
    ? payload.hyperSymbols.filter((symbol): symbol is string => typeof symbol === "string")
    : [];
  const binanceSymbols = Array.isArray(payload.binanceSymbols)
    ? payload.binanceSymbols.filter((symbol): symbol is string => typeof symbol === "string")
    : [];

  try {
    const [hyperliquid, binance] = await Promise.all([
      fetchHyperliquidFundingRates(hyperSymbols),
      fetchBinanceFundingRates(binanceSymbols),
    ]);

    return NextResponse.json({
      hyperliquid,
      binance,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to proxy funding rates.",
      },
      { status: 500 },
    );
  }
}
