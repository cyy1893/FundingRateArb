import { Suspense } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PerpTable } from "@/components/perp-table";
import { SettlementCountdown } from "@/components/settlement-countdown";
import {
  DEFAULT_FUNDING_PERIOD_HOURS,
  computeNextSettlementTimestamp,
} from "@/lib/funding";
import type { MarketRow } from "@/types/market";

type UniverseAsset = {
  name: string;
  maxLeverage: number;
  isDelisted?: boolean;
};

type MetaPayload = {
  universe: UniverseAsset[];
};

type AssetContext = {
  markPx: string;
  dayNtlVlm: string;
  funding: string;
  openInterest: string;
};

type MetaAndAssetCtxsResponse = [MetaPayload, AssetContext[]];

type ApiError = {
  source: string;
  message: string;
};

type PerpSnapshot = {
  rows: MarketRow[];
  fetchedAt: Date;
  errors: ApiError[];
};

type BinancePerpMetrics = {
  maxLeverage: number | null;
  fundingRate: number | null;
  fundingIntervalHours: number | null;
  volumeUsd: number | null;
};

type CoingeckoMarket = {
  id: string;
  name: string;
  image: string | null;
  symbol: string;
  total_volume: number;
  price_change_percentage_1h_in_currency?: number | null;
  price_change_percentage_24h_in_currency?: number | null;
  price_change_percentage_7d_in_currency?: number | null;
};

async function getBinancePerpMetrics(apiErrors: ApiError[]): Promise<
  Map<string, BinancePerpMetrics>
> {
  try {
    const [exchangeInfoRes, premiumRes, fundingInfoRes, tickerRes] =
      await Promise.all([
        fetch("https://fapi.binance.com/fapi/v1/exchangeInfo", {
          cache: "no-store",
        }),
        fetch("https://fapi.binance.com/fapi/v1/premiumIndex", {
          cache: "no-store",
        }),
        fetch("https://fapi.binance.com/fapi/v1/fundingInfo", {
          cache: "no-store",
        }),
        fetch("https://fapi.binance.com/fapi/v1/ticker/24hr", {
          cache: "no-store",
        }),
      ]);

    if (!exchangeInfoRes.ok || !premiumRes.ok) {
      return new Map();
    }

    const exchangeInfo = (await exchangeInfoRes.json()) as {
      symbols?: Array<{
        symbol: string;
        quoteAsset: string;
        contractType: string;
        filters?: Array<{ filterType: string; maxLeverage?: string }>;
      }>;
    };

    const leverageMap = new Map<string, number | null>();
    exchangeInfo.symbols
      ?.filter(
        (item) =>
          item.contractType === "PERPETUAL" && item.quoteAsset === "USDC",
      )
      .forEach((item) => {
        const leverageFilter = item.filters?.find(
          (filter) => filter.filterType === "LEVERAGE",
        );
        const maxLeverage = leverageFilter?.maxLeverage
          ? Number.parseInt(leverageFilter.maxLeverage, 10)
          : null;
        leverageMap.set(item.symbol, Number.isNaN(maxLeverage) ? null : maxLeverage);
      });

    const premiumIndex = (await premiumRes.json()) as Array<{
      symbol: string;
      lastFundingRate: string;
    }>;

    const fundingMap = new Map<string, number | null>();
    premiumIndex
      ?.filter((item) => item.symbol.endsWith("USDC"))
      .forEach((item) => {
        const funding = Number.parseFloat(item.lastFundingRate);
        fundingMap.set(item.symbol, Number.isFinite(funding) ? funding : null);
      });

    const fundingIntervalMap = new Map<string, number | null>();
    if (fundingInfoRes.ok) {
      const fundingInfo = (await fundingInfoRes.json()) as Array<{
        symbol: string;
        fundingIntervalHours?: number | string;
      }>;

      fundingInfo
        ?.filter((item) => item.symbol.endsWith("USDC"))
        .forEach((item) => {
          const hours =
            typeof item.fundingIntervalHours === "string"
              ? Number.parseInt(item.fundingIntervalHours, 10)
              : item.fundingIntervalHours;
          fundingIntervalMap.set(
            item.symbol,
            hours != null && Number.isFinite(hours) ? hours : null,
          );
        });
    }

    const volumeMap = new Map<string, number | null>();
    if (tickerRes.ok) {
      const tickerData = (await tickerRes.json()) as Array<{
        symbol: string;
        quoteVolume?: string;
        volume?: string;
      }>;

      tickerData
        ?.filter((item) => item.symbol.endsWith("USDC"))
        .forEach((item) => {
          const volume = Number.parseFloat(
            item.quoteVolume ?? item.volume ?? "",
          );
          volumeMap.set(
            item.symbol,
            Number.isFinite(volume) && volume >= 0 ? volume : null,
          );
        });
    }

    const combined = new Map<string, BinancePerpMetrics>();
    const symbols = new Set([
      ...leverageMap.keys(),
      ...fundingMap.keys(),
      ...fundingIntervalMap.keys(),
      ...volumeMap.keys(),
    ]);
    symbols.forEach((symbol) => {
      combined.set(symbol, {
        maxLeverage: leverageMap.get(symbol) ?? null,
        fundingRate: fundingMap.get(symbol) ?? null,
        fundingIntervalHours: fundingIntervalMap.get(symbol) ?? null,
        volumeUsd: volumeMap.get(symbol) ?? null,
      });
    });

    return combined;
  } catch (error) {
    apiErrors.push({
      source: "Binance Futures API",
      message:
        error instanceof Error ? error.message : "无法获取 Binance 数据。",
    });
    return new Map();
  }
}

const API_URL = "https://api.hyperliquid.xyz/info";
const COINGECKO_MARKETS_URL =
  "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=250&sparkline=false&price_change_percentage=1h,24h,7d";

type CoinGeckoSnapshot = {
  id: string;
  name: string;
  image: string | null;
  symbol: string;
  volumeUsd: number | null;
  priceChange1h: number | null;
  priceChange24h: number | null;
  priceChange7d: number | null;
};

async function getCoinGeckoMarketData(
  symbols: string[],
  apiErrors: ApiError[],
): Promise<Map<string, CoinGeckoSnapshot>> {
  const targetSymbols = new Set(symbols.map((symbol) => symbol.toUpperCase()));
  const markets = new Map<string, CoinGeckoSnapshot>();

  if (targetSymbols.size === 0) {
    return markets;
  }

  try {
    const perPage = 250;
    const maxPages = 4;

    for (let page = 1; page <= maxPages && targetSymbols.size > 0; page += 1) {
      const response = await fetch(`${COINGECKO_MARKETS_URL}&page=${page}`, {
        cache: "no-store",
      });

      if (!response.ok) {
        break;
      }

      const data = (await response.json()) as CoingeckoMarket[];
      data.forEach((item) => {
        const symbolUpper = item.symbol?.toUpperCase();
        if (!symbolUpper || !targetSymbols.has(symbolUpper)) {
          return;
        }

        const volume = Number(item.total_volume);
        const priceChange1hRaw = item.price_change_percentage_1h_in_currency;
        const priceChange24hRaw = item.price_change_percentage_24h_in_currency;
        const priceChange7dRaw = item.price_change_percentage_7d_in_currency;

        const snapshot: CoinGeckoSnapshot = {
          id: item.id ?? symbolUpper.toLowerCase(),
          name: item.name ?? symbolUpper,
          image: item.image ?? null,
          symbol: symbolUpper,
          volumeUsd: Number.isFinite(volume) ? volume : null,
          priceChange1h:
            typeof priceChange1hRaw === "number" && Number.isFinite(priceChange1hRaw)
              ? priceChange1hRaw
              : null,
          priceChange24h:
            typeof priceChange24hRaw === "number" &&
            Number.isFinite(priceChange24hRaw)
              ? priceChange24hRaw
              : null,
          priceChange7d:
            typeof priceChange7dRaw === "number" && Number.isFinite(priceChange7dRaw)
              ? priceChange7dRaw
              : null,
        };

        const existing = markets.get(symbolUpper);
        const shouldUpdate =
          existing == null ||
          ((snapshot.volumeUsd ?? -Infinity) > (existing.volumeUsd ?? -Infinity));

        if (shouldUpdate) {
          markets.set(symbolUpper, snapshot);
          targetSymbols.delete(symbolUpper);
        }
      });

      if (data.length < perPage) {
        break;
      }
    }
  } catch (error) {
    apiErrors.push({
      source: "CoinGecko API",
      message:
        error instanceof Error ? error.message : "无法获取 CoinGecko 数据。",
    });
    return markets;
  }

  return markets;
}

async function getPerpetualSnapshot(): Promise<PerpSnapshot> {
  const apiErrors: ApiError[] = [];
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Hyperliquid API responded with ${response.status}`);
  }

  const raw = (await response.json()) as MetaAndAssetCtxsResponse | unknown;

  if (
    !Array.isArray(raw) ||
    raw.length < 2 ||
    typeof raw[0] !== "object" ||
    raw[0] === null ||
    !Array.isArray(raw[1])
  ) {
    throw new Error("Unexpected data shape received from Hyperliquid API");
  }

  const [meta, contexts] = raw as MetaAndAssetCtxsResponse;
  const fetchedAt = new Date();
  const [binanceMetrics, coingeckoMarkets] = await Promise.all([
    getBinancePerpMetrics(apiErrors),
    getCoinGeckoMarketData(
      meta.universe.map((asset) => asset.name),
      apiErrors,
    ),
  ]);

  const rows: MarketRow[] = [];

  meta.universe.forEach((asset, index) => {
    if (!asset || asset.isDelisted) {
      return;
    }

    const ctx = contexts[index];
    if (!ctx) {
      return;
    }

    const markPrice = Number.parseFloat(ctx.markPx);
    const dayNotionalVolumeRaw = Number.parseFloat(ctx.dayNtlVlm);
    const dayNotionalVolume = Number.isFinite(dayNotionalVolumeRaw)
      ? dayNotionalVolumeRaw
      : null;
    const fundingRate = Number.parseFloat(ctx.funding);
    const openInterest = Number.parseFloat(ctx.openInterest);
    const binanceSymbol = `${asset.name}USDC`;
    const binanceInfo = binanceMetrics.get(binanceSymbol);
    const fundingPeriodHours =
      binanceInfo?.fundingIntervalHours ?? DEFAULT_FUNDING_PERIOD_HOURS;
    const binanceHourlyFunding =
      binanceInfo?.fundingRate != null
        ? binanceInfo.fundingRate / Math.max(fundingPeriodHours, 1)
        : null;
    const binanceVolumeUsd =
      binanceInfo?.volumeUsd != null && Number.isFinite(binanceInfo.volumeUsd)
        ? binanceInfo.volumeUsd
        : null;
    const combinedVolumeUsd =
      dayNotionalVolume !== null || binanceVolumeUsd !== null
        ? (dayNotionalVolume ?? 0) + (binanceVolumeUsd ?? 0)
        : null;
    const hasBinanceData =
      binanceInfo != null &&
      (binanceInfo.maxLeverage !== null ||
        binanceHourlyFunding !== null ||
        binanceVolumeUsd !== null);

    const binanceData: MarketRow["binance"] =
      binanceInfo != null && hasBinanceData
        ? {
            symbol: binanceSymbol,
            maxLeverage: binanceInfo.maxLeverage,
            fundingRate:
              binanceHourlyFunding !== null &&
              Number.isFinite(binanceHourlyFunding)
                ? binanceHourlyFunding
                : null,
            volumeUsd: binanceVolumeUsd,
            fundingPeriodHours:
              Number.isFinite(fundingPeriodHours) && fundingPeriodHours > 0
                ? fundingPeriodHours
                : null,
          }
        : null;
    const coingeckoEntry =
      coingeckoMarkets.get(asset.name.toUpperCase()) ?? null;

    const row: MarketRow = {
      symbol: asset.name,
      displayName: coingeckoEntry?.name ?? asset.name,
      iconUrl: coingeckoEntry?.image ?? null,
      coingeckoId: coingeckoEntry?.id ?? null,
      maxLeverage: asset.maxLeverage,
      markPrice: Number.isFinite(markPrice) ? markPrice : 0,
      priceChange1h: coingeckoEntry?.priceChange1h ?? null,
      priceChange24h: coingeckoEntry?.priceChange24h ?? null,
      priceChange7d: coingeckoEntry?.priceChange7d ?? null,
      dayNotionalVolume,
      fundingRate: Number.isFinite(fundingRate) ? fundingRate : 0,
      openInterest: Number.isFinite(openInterest) ? openInterest : 0,
      volumeUsd: combinedVolumeUsd,
      binance: binanceData,
    };

    rows.push(row);
  });

  rows.sort((a, b) => {
    const volumeA = a.volumeUsd ?? a.dayNotionalVolume ?? 0;
    const volumeB = b.volumeUsd ?? b.dayNotionalVolume ?? 0;
    return volumeB - volumeA;
  });

  return {
    rows,
    fetchedAt,
    errors: apiErrors,
  };
}

export const revalidate = 0;

export default function Home() {
  return (
    <div className="min-h-screen bg-muted/20 py-10">
      <div className="container mx-auto flex max-w-[1900px] flex-col gap-6 px-4">
        <Suspense fallback={<DashboardSkeleton />}>
          <DashboardContent />
        </Suspense>
      </div>
    </div>
  );
}

async function DashboardContent() {
  let snapshot: PerpSnapshot | null = null;
  let errorMessage: string | null = null;

  try {
    snapshot = await getPerpetualSnapshot();
  } catch (error) {
    errorMessage =
      error instanceof Error
        ? error.message
        : "无法加载 Hyperliquid 市场数据。";
  }

  const rows = snapshot?.rows ?? [];
  const fetchedAt = snapshot?.fetchedAt ?? new Date();
  const apiErrors = snapshot?.errors ?? [];
  const settlementPeriodHours = 1;
  const nextSettlementIso = computeNextSettlementTimestamp(
    fetchedAt,
    settlementPeriodHours,
  );

  return (
    <Card className="border-border/60">
      <CardHeader className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <CardTitle className="text-2xl font-semibold tracking-tight">
            资金费率比较
          </CardTitle>
          <CardDescription className="max-w-2xl text-sm text-muted-foreground">
            各交易所资金费率的差异。
          </CardDescription>
        </div>
        <div className="rounded-lg border border-border/70 bg-muted/40 px-4 py-3 text-sm">
          <div className="flex flex-col gap-3 text-muted-foreground">
            <div className="flex items-center justify-between gap-8">
              <div className="flex flex-col gap-1">
                <span className="uppercase tracking-wide text-xs">
                  资金结算（整点）
                </span>
                <SettlementCountdown
                  targetIso={nextSettlementIso}
                  className="text-lg"
                />
              </div>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {errorMessage ? (
          <Alert variant="destructive">
            <AlertTitle>数据获取失败</AlertTitle>
            <AlertDescription>
              请求失败：{errorMessage}，请稍后重试。
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {apiErrors.length > 0 ? (
              <Alert variant="default">
                <AlertTitle>部分数据来源不可用</AlertTitle>
                <AlertDescription>
                  <ul className="mt-2 list-disc space-y-1 pl-4 text-xs">
                    {apiErrors.map((apiError, index) => (
                      <li key={`${apiError.source}-${index}`}>
                        <span className="font-semibold">
                          {apiError.source}:
                        </span>{" "}
                        <span>{apiError.message}</span>
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}
            <PerpTable rows={rows} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <Card className="border-border/60">
      <CardHeader className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="w-full space-y-2 animate-pulse">
          <div className="h-6 w-48 rounded bg-muted" />
          <div className="h-4 w-64 rounded bg-muted/80" />
        </div>
        <div className="rounded-lg border border-border/70 bg-muted/40 px-4 py-3 text-sm">
          <div className="flex flex-col gap-3 text-muted-foreground">
            <div className="flex items-center justify-between gap-8">
              <div className="flex flex-col gap-2">
                <span className="h-3 w-24 rounded bg-muted/80" />
                <span className="h-6 w-32 rounded bg-muted" />
              </div>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3">
          <div className="h-4 w-40 rounded bg-muted/70" />
          <div className="h-11 rounded-lg bg-muted/60" />
          <div className="h-8 rounded bg-muted/40" />
        </div>
        <div className="rounded-xl border border-dashed border-border/70">
          <div className="h-[520px] w-full animate-pulse rounded-xl bg-muted/40" />
        </div>
      </CardContent>
    </Card>
  );
}
