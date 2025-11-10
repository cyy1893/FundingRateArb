"use client";

/* eslint-disable @next/next/no-img-element */

import {
  ChangeEvent,
  WheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronDown, ChevronUp, Loader2 } from "lucide-react";

import { PerpTableRow } from "@/components/perp-table-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DEFAULT_FUNDING_PERIOD_HOURS,
  formatSettlementPeriod,
} from "@/lib/funding";
import { cn } from "@/lib/utils";
import type { MarketRow } from "@/types/market";
import {
  Brush,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { BrushChangeState } from "recharts/types/component/Brush";

type PerpTableProps = {
  rows: MarketRow[];
  pageSize?: number;
};

const DEFAULT_PAGE_SIZE = 15;
const FETCH_INTERVAL_MS = 15000;
const SORT_REFRESH_CACHE_MS = 5000;
const DISPLAY_FUNDING_PERIOD_HOURS = 1;

type SortColumn =
  | "markPrice"
  | "maxLeverage"
  | "funding"
  | "binanceFunding"
  | "arbitrage"
  | "volumeHyperliquid"
  | "volumeBinance";
type ExchangeFilter = "intersection" | "any";

type HyperliquidFundingResponse = [
  {
    universe: Array<{
      name: string;
    }>;
  },
  Array<{
    funding: string;
  }>
];

type FundingHistoryPoint = {
  time: number;
  hyperliquid?: number | null;
  binance?: number | null;
  arbitrage?: number | null;
};

const HISTORY_OPTIONS = [
  { label: "1 天", value: 1 },
  { label: "1 周", value: 7 },
  { label: "1 月", value: 30 },
] as const;
type HistoryOptionValue = (typeof HISTORY_OPTIONS)[number]["value"];

const DEFAULT_HISTORY_RANGE_DAYS: HistoryOptionValue = 7;
const MS_PER_HOUR = 60 * 60 * 1000;
const DEFAULT_BINANCE_FUNDING_PERIOD_HOURS = 8;
const MAX_HYPER_FUNDING_POINTS = 500;
const MAX_HYPER_LOOKBACK_MS = MAX_HYPER_FUNDING_POINTS * MS_PER_HOUR;
const HOURS_PER_YEAR = 24 * 365;
const MIN_HISTORY_WINDOW_MS = 3 * MS_PER_HOUR;
const HISTORY_PAN_SENSITIVITY = 900;
const HISTORY_WHEEL_ZOOM_STEP = 0.18;

const historyTickFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
});

const historyTooltipFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const historyPercentFormatter = new Intl.NumberFormat("en-US", {
  minimumSignificantDigits: 2,
  maximumSignificantDigits: 5,
  useGrouping: false,
});

function formatHistoryPercentValue(value: number): string {
  if (!Number.isFinite(value)) {
    return "—";
  }
  return historyPercentFormatter.format(value);
}

function formatAnnualizedPercentFromHourly(value: number): string {
  if (!Number.isFinite(value)) {
    return "—";
  }
  const annualized = Math.abs(value) * HOURS_PER_YEAR;
  return formatHistoryPercentValue(annualized);
}

function formatHistoryTooltipValue(value: number): string {
  if (!Number.isFinite(value)) {
    return "—";
  }
  const hourly = formatHistoryPercentValue(value);
  const annualized = formatAnnualizedPercentFromHourly(value);
  return `${hourly}% · 年化 ${annualized}%`;
}

function clampHistoryDomain(
  domain: [number, number],
  bounds: [number, number],
): [number, number] {
  const [minBound, maxBound] = bounds;
  if (!Number.isFinite(minBound) || !Number.isFinite(maxBound)) {
    return domain;
  }

  const totalSpan = Math.max(maxBound - minBound, 0);
  if (totalSpan === 0) {
    return [minBound, maxBound];
  }

  const [start, end] = domain[0] <= domain[1] ? domain : [domain[1], domain[0]];
  const minWindow = Math.min(MIN_HISTORY_WINDOW_MS, totalSpan);
  const requestedSpan = Math.max(end - start, minWindow);

  if (requestedSpan >= totalSpan) {
    return [minBound, maxBound];
  }

  let clampedStart = Math.min(
    Math.max(start, minBound),
    maxBound - requestedSpan,
  );
  let clampedEnd = clampedStart + requestedSpan;

  if (clampedEnd > maxBound) {
    clampedEnd = maxBound;
    clampedStart = clampedEnd - requestedSpan;
  }

  return [clampedStart, clampedEnd];
}

function findNearestIndexByTime(
  data: FundingHistoryPoint[],
  target: number,
  mode: "floor" | "ceil",
): number {
  if (data.length === 0) {
    return 0;
  }

  if (mode === "floor" && target <= data[0].time) {
    return 0;
  }
  if (mode === "ceil" && target <= data[0].time) {
    return 0;
  }
  if (mode === "ceil" && target >= data[data.length - 1].time) {
    return data.length - 1;
  }
  if (mode === "floor" && target >= data[data.length - 1].time) {
    return data.length - 1;
  }

  let low = 0;
  let high = data.length - 1;
  let result = mode === "floor" ? 0 : data.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const midTime = data[mid].time;

    if (midTime === target) {
      return mid;
    }

    if (midTime < target) {
      low = mid + 1;
      if (mode === "floor") {
        result = mid;
      }
    } else {
      high = mid - 1;
      if (mode === "ceil") {
        result = mid;
      }
    }
  }

  return result;
}

async function fetchHyperliquidFundingRates(
  symbols: string[],
): Promise<Record<string, number>> {
  if (symbols.length === 0) {
    return {};
  }

  try {
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
    const targetSymbols = new Set(
      symbols.map((symbol) => symbol.toUpperCase()),
    );

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
  } catch {
    return {};
  }
}

async function fetchBinanceFundingRates(
  symbols: string[],
): Promise<Record<string, number>> {
  if (symbols.length === 0) {
    return {};
  }

  try {
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
  } catch {
    return {};
  }
}

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
    throw new Error("Hyperliquid 资金费率历史请求失败");
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
    throw new Error("Binance 资金费率历史请求失败");
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

async function fetchFundingHistoryDataset(
  symbol: string,
  binanceSymbol: string | null,
  days: number,
  binanceFundingPeriodHours: number | null,
): Promise<FundingHistoryPoint[]> {
  const now = Date.now();
  const desiredStart = now - days * 24 * MS_PER_HOUR;
  const latestAllowedStart = now - MAX_HYPER_LOOKBACK_MS;
  const startTime = Math.max(desiredStart, latestAllowedStart);
  const [hyperHistory, binanceHistory] = await Promise.all([
    fetchHyperliquidFundingHistorySeries(symbol, startTime).catch(() => []),
    binanceSymbol
      ? fetchBinanceFundingHistorySeries(binanceSymbol, startTime).catch(
          () => [],
        )
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
        typeof binanceValue === "number"
          ? binanceValue - hyperValue
          : null,
    });
  });

  return dataset;
}

function getHistoryCacheKey(
  symbol: string,
  binanceSymbol: string | null,
  binanceFundingPeriodHours: number | null,
) {
  return `${symbol}__${binanceSymbol ?? "none"}__${
    binanceFundingPeriodHours ?? "default"
  }`;
}

export function PerpTable({
  rows,
  pageSize = DEFAULT_PAGE_SIZE,
}: PerpTableProps) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [sortColumn, setSortColumn] = useState<SortColumn | null>(null);
  const [sortDirection, setSortDirection] = useState<"desc" | "asc">("desc");
  const [exchangeFilter, setExchangeFilter] =
    useState<ExchangeFilter>("intersection");
  const [liveFunding, setLiveFunding] = useState<{
    hyperliquid: Record<string, number>;
    binance: Record<string, number>;
  }>({
    hyperliquid: {},
    binance: {},
  });
  const [isBlockingRefresh, setIsBlockingRefresh] = useState(false);
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [historyTarget, setHistoryTarget] = useState<{
    symbol: string;
    displayName: string;
    binanceSymbol: string | null;
    binanceFundingPeriodHours: number | null;
  } | null>(null);
  const [historyData, setHistoryData] = useState<FundingHistoryPoint[] | null>(
    null,
  );
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyCacheRef = useRef<
    Record<string, Record<number, FundingHistoryPoint[]>>
  >({});
  const historyChartWrapperRef = useRef<HTMLDivElement | null>(null);
  const displayPeriodHours = DISPLAY_FUNDING_PERIOD_HOURS;
  const [historyRangeDays, setHistoryRangeDays] =
    useState<HistoryOptionValue>(DEFAULT_HISTORY_RANGE_DAYS);
  const historyRangeMeta =
    HISTORY_OPTIONS.find((option) => option.value === historyRangeDays) ??
    HISTORY_OPTIONS[1];
  const historyRangeDurationMs = historyRangeDays * 24 * MS_PER_HOUR;
  const [historyViewport, setHistoryViewport] = useState<[number, number] | null>(
    null,
  );
  const historyDataSignature = useMemo(() => {
    if (!historyData?.length) {
      return "empty";
    }
    const first = historyData[0]?.time ?? 0;
    const last = historyData[historyData.length - 1]?.time ?? 0;
    return `${historyData.length}-${first}-${last}`;
  }, [historyData]);
  useEffect(() => {
    setHistoryViewport(null);
  }, [historyDataSignature, historyRangeDays]);
  const historyTimeBounds = useMemo<[number, number] | null>(() => {
    if (!historyData?.length) {
      return null;
    }
    const first = historyData[0].time;
    const last = historyData[historyData.length - 1].time;
    if (!Number.isFinite(first) || !Number.isFinite(last)) {
      return null;
    }
    return [first, last];
  }, [historyData]);
  const historyDefaultDomain = useMemo<[number, number] | null>(() => {
    if (!historyTimeBounds) {
      return null;
    }
    const [minTime, maxTime] = historyTimeBounds;
    const availableSpan = Math.max(maxTime - minTime, 0);
    if (availableSpan === 0) {
      return [minTime, maxTime];
    }
    const desiredSpan = Math.min(historyRangeDurationMs, availableSpan);
    const span = desiredSpan > 0 ? desiredSpan : availableSpan;
    const start = Math.max(minTime, maxTime - span);
    return [start, maxTime];
  }, [historyTimeBounds, historyRangeDurationMs]);
  const historyXAxisDomain = historyViewport ?? historyDefaultDomain ?? null;
  const historyBrushState = useMemo(() => {
    if (!historyData?.length) {
      return null;
    }
    if (!historyXAxisDomain) {
      return { startIndex: 0, endIndex: historyData.length - 1 };
    }
    const [domainStart, domainEnd] = historyXAxisDomain;
    return {
      startIndex: findNearestIndexByTime(historyData, domainStart, "floor"),
      endIndex: findNearestIndexByTime(historyData, domainEnd, "ceil"),
    };
  }, [historyData, historyXAxisDomain]);

  const normalizedSearch = search.trim().toLowerCase();

  const filteredRows = useMemo(() => {
    const matchesSearch = (row: MarketRow) =>
      row.symbol.toLowerCase().includes(normalizedSearch);

    const matchesExchange = (row: MarketRow) =>
      exchangeFilter === "intersection" ? Boolean(row.binance) : true;

    return rows.filter((row) => matchesSearch(row) && matchesExchange(row));
  }, [normalizedSearch, rows, exchangeFilter]);

  const fundingColumnLabel = "Hyperliquid 1 小时资金费率";
  const hyperliquidSettlementLabel = formatSettlementPeriod(
    DEFAULT_FUNDING_PERIOD_HOURS,
  );

  const handlePageChange = (nextPage: number) => {
    if (nextPage >= 1 && nextPage <= pageCount) {
      setPage(nextPage);
    }
  };

  const handleSearchChange = (value: string) => {
    setSearch(value);
    setPage(1);
  };

  const handleExchangeFilterChange = (event: ChangeEvent<HTMLInputElement>) => {
    setExchangeFilter(event.target.value as ExchangeFilter);
    setPage(1);
  };

  const handleHistoryClick = useCallback(
    (row: MarketRow) => {
      const target = {
        symbol: row.symbol,
        displayName: row.displayName ?? row.symbol,
        binanceSymbol: row.binance?.symbol ?? null,
        binanceFundingPeriodHours: row.binance?.fundingPeriodHours ?? null,
      };
      setHistoryTarget(target);
      setHistoryError(null);
      const cacheKey = getHistoryCacheKey(
        row.symbol,
        target.binanceSymbol,
        target.binanceFundingPeriodHours,
      );
      const cached =
        historyCacheRef.current[cacheKey]?.[historyRangeDays] ?? null;
      setHistoryData(cached);
      setHistoryLoading(!cached);
      setHistoryDialogOpen(true);
    },
    [historyRangeDays],
  );

  const handleHistoryRangeChange = useCallback(
    (value: HistoryOptionValue) => {
      if (value === historyRangeDays) {
        return;
      }
      setHistoryRangeDays(value);
      if (!historyTarget) {
        return;
      }
      const cacheKey = getHistoryCacheKey(
        historyTarget.symbol,
        historyTarget.binanceSymbol,
        historyTarget.binanceFundingPeriodHours,
      );
      const cached = historyCacheRef.current[cacheKey]?.[value] ?? null;
      setHistoryData(cached ?? null);
      if (historyDialogOpen) {
        setHistoryError(null);
        setHistoryLoading(!cached);
      }
    },
    [historyRangeDays, historyTarget, historyDialogOpen],
  );
  const historyInteractionsDisabled = !historyData?.length || !historyTimeBounds;
  const updateHistoryViewport = useCallback(
    (nextDomain: [number, number]) => {
      if (!historyTimeBounds) {
        setHistoryViewport(nextDomain);
        return;
      }
      setHistoryViewport(clampHistoryDomain(nextDomain, historyTimeBounds));
    },
    [historyTimeBounds],
  );
  const handleHistoryBrushChange = useCallback(
    (range?: BrushChangeState) => {
      if (!historyData?.length || !historyTimeBounds || !range) {
        return;
      }
      const startIndex = Math.max(
        0,
        Math.min(range.startIndex ?? 0, historyData.length - 1),
      );
      const endIndex = Math.max(
        0,
        Math.min(range.endIndex ?? historyData.length - 1, historyData.length - 1),
      );
      if (startIndex === endIndex) {
        return;
      }
      const low = Math.min(startIndex, endIndex);
      const high = Math.max(startIndex, endIndex);
      const nextDomain: [number, number] = [
        historyData[low].time,
        historyData[high].time,
      ];
      updateHistoryViewport(nextDomain);
    },
    [historyData, historyTimeBounds, updateHistoryViewport],
  );
  const handleHistoryResetViewport = useCallback(() => {
    setHistoryViewport(null);
  }, []);
  const handleHistoryZoom = useCallback(
    (direction: "in" | "out") => {
      if (!historyTimeBounds) {
        return;
      }
      const activeDomain = historyViewport ?? historyDefaultDomain;
      if (!activeDomain) {
        return;
      }
      const [start, end] = activeDomain;
      const currentSpan = Math.max(end - start, MIN_HISTORY_WINDOW_MS);
      const totalSpan = Math.max(
        historyTimeBounds[1] - historyTimeBounds[0],
        MIN_HISTORY_WINDOW_MS,
      );
      if (totalSpan === 0) {
        return;
      }
      const zoomFactor = direction === "in" ? 0.75 : 1.25;
      const nextSpan = Math.min(
        Math.max(currentSpan * zoomFactor, MIN_HISTORY_WINDOW_MS),
        totalSpan,
      );
      const center = start + currentSpan / 2;
      const nextDomain: [number, number] = [
        center - nextSpan / 2,
        center + nextSpan / 2,
      ];
      updateHistoryViewport(nextDomain);
    },
    [historyDefaultDomain, historyTimeBounds, historyViewport, updateHistoryViewport],
  );
  const handleHistoryWheel = useCallback(
    (event: WheelEvent<HTMLDivElement>) => {
      if (!historyData?.length || !historyTimeBounds) {
        return;
      }
      const activeDomain = historyViewport ?? historyDefaultDomain;
      if (!activeDomain) {
        return;
      }
      const totalSpan = Math.max(
        historyTimeBounds[1] - historyTimeBounds[0],
        MIN_HISTORY_WINDOW_MS,
      );
      if (totalSpan === 0) {
        return;
      }

      event.preventDefault();
      const [start, end] = activeDomain;
      const currentSpan = Math.max(end - start, MIN_HISTORY_WINDOW_MS);
      const shouldPan =
        event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);

      if (shouldPan) {
        const rawDelta = event.deltaX || event.deltaY;
        if (rawDelta === 0) {
          return;
        }
        const shiftRatio = rawDelta / HISTORY_PAN_SENSITIVITY;
        if (shiftRatio === 0) {
          return;
        }
        const shift = currentSpan * shiftRatio;
        updateHistoryViewport([start + shift, end + shift]);
        return;
      }

      if (event.deltaY === 0) {
        return;
      }

      const zoomDirection = Math.sign(event.deltaY);
      const nextSpan = Math.min(
        Math.max(
          currentSpan * (1 + HISTORY_WHEEL_ZOOM_STEP * zoomDirection),
          MIN_HISTORY_WINDOW_MS,
        ),
        totalSpan,
      );
      const container = historyChartWrapperRef.current;
      let focusRatio = 0.5;
      if (container) {
        const rect = container.getBoundingClientRect();
        if (rect.width > 0) {
          const relativeX = Math.min(
            Math.max(event.clientX - rect.left, 0),
            rect.width,
          );
          focusRatio = relativeX / rect.width;
        }
      }
      const focusPoint = start + currentSpan * focusRatio;
      const nextDomain: [number, number] = [
        focusPoint - nextSpan * focusRatio,
        focusPoint + nextSpan * (1 - focusRatio),
      ];
      updateHistoryViewport(nextDomain);
    },
    [
      historyData,
      historyDefaultDomain,
      historyTimeBounds,
      historyViewport,
      updateHistoryViewport,
    ],
  );

  const sortedRows = useMemo(() => {
    if (!sortColumn) {
      return filteredRows;
    }

    const rowsWithIndex = filteredRows.map((row, index) => ({
      row,
      index,
    }));

    const getValue = (row: MarketRow) => {
      switch (sortColumn) {
        case "markPrice":
          return row.markPrice;
        case "maxLeverage":
          return row.maxLeverage;
        case "funding":
        {
          const live = liveFunding.hyperliquid[row.symbol];
          const funding = Number.isFinite(live) ? live : row.fundingRate;
          return funding * displayPeriodHours;
        }
        case "binanceFunding":
        {
          if (!row.binance?.symbol) {
            return Number.NEGATIVE_INFINITY;
          }

          const live = liveFunding.binance[row.binance.symbol];
          const funding =
            Number.isFinite(live) && live !== undefined
              ? live
              : row.binance.fundingRate ?? null;
          if (funding === null) {
            return Number.NEGATIVE_INFINITY;
          }

          return funding;
        }
        case "arbitrage": {
          const liveHyper =
            liveFunding.hyperliquid[row.symbol] ?? row.fundingRate;

          const binanceHourly =
            row.binance?.symbol != null
              ? liveFunding.binance[row.binance.symbol] ??
                row.binance.fundingRate ??
                null
              : null;

          if (binanceHourly === null || !Number.isFinite(liveHyper)) {
            return Number.NEGATIVE_INFINITY;
          }

          return Math.abs(liveHyper - binanceHourly);
        }
        case "volumeHyperliquid":
          return row.dayNotionalVolume ?? Number.NEGATIVE_INFINITY;
        case "volumeBinance":
          return row.binance?.volumeUsd ?? Number.NEGATIVE_INFINITY;
        default:
          return 0;
      }
    };

    rowsWithIndex.sort((a, b) => {
      const valueA = getValue(a.row);
      const valueB = getValue(b.row);

      const safeA = Number.isFinite(valueA) ? valueA : Number.NEGATIVE_INFINITY;
      const safeB = Number.isFinite(valueB) ? valueB : Number.NEGATIVE_INFINITY;

      if (safeA === safeB) {
        return a.index - b.index;
      }

      return sortDirection === "desc" ? safeB - safeA : safeA - safeB;
    });

    return rowsWithIndex.map(({ row }) => row);
  }, [filteredRows, sortColumn, sortDirection, displayPeriodHours, liveFunding]);

  const getSortState = (column: SortColumn): "asc" | "desc" | null => {
    if (sortColumn !== column) {
      return null;
    }

    return sortDirection;
  };

  const renderSortIcon = (column: SortColumn) => {
    const state = getSortState(column);
    const baseIconClasses =
      "h-3.5 w-3.5 text-muted-foreground transition-opacity duration-150";

    if (state === "desc") {
      return <ChevronDown className={baseIconClasses} />;
    }

    if (state === "asc") {
      return <ChevronUp className={baseIconClasses} />;
    }

    return <ChevronDown className={`${baseIconClasses} opacity-0`} />;
  };

  const sortedLength = sortedRows.length;
  const pageCount = Math.max(1, Math.ceil(sortedLength / pageSize));
  const currentPage = Math.min(page, pageCount);
  const startIndex = (currentPage - 1) * pageSize;
  const currentRows = useMemo(
    () => sortedRows.slice(startIndex, startIndex + pageSize),
    [sortedRows, startIndex, pageSize],
  );
  const hyperSymbolsRef = useRef<string[]>([]);
  const binanceSymbolsRef = useRef<string[]>([]);
  const lastFetchRef = useRef<number>(0);
  const isFetchingRef = useRef<boolean>(false);

  useEffect(() => {
    hyperSymbolsRef.current = currentRows.map((row) => row.symbol);
    binanceSymbolsRef.current = currentRows
      .map((row) => row.binance?.symbol)
      .filter((symbol): symbol is string => Boolean(symbol));
  }, [currentRows]);

  useEffect(() => {
    if (!historyDialogOpen || !historyTarget) {
      return;
    }

    const cacheKey = getHistoryCacheKey(
      historyTarget.symbol,
      historyTarget.binanceSymbol,
      historyTarget.binanceFundingPeriodHours,
    );
    const cached =
      historyCacheRef.current[cacheKey]?.[historyRangeDays] ?? null;
    if (cached) {
      setHistoryData(cached);
      setHistoryLoading(false);
      setHistoryError(null);
      return;
    }

    let cancelled = false;
    setHistoryLoading(true);
    setHistoryError(null);

    fetchFundingHistoryDataset(
      historyTarget.symbol,
      historyTarget.binanceSymbol,
      historyRangeDays,
      historyTarget.binanceFundingPeriodHours,
    )
      .then((dataset) => {
        if (cancelled) {
          return;
        }
        historyCacheRef.current[cacheKey] = {
          ...(historyCacheRef.current[cacheKey] ?? {}),
          [historyRangeDays]: dataset,
        };
        setHistoryData(dataset);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setHistoryError(
          error instanceof Error
            ? error.message
            : "获取资金费率历史失败，请稍后重试。",
        );
      })
      .finally(() => {
        if (!cancelled) {
          setHistoryLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [historyDialogOpen, historyTarget, historyRangeDays]);

  const showingFrom = sortedLength === 0 ? 0 : startIndex + 1;
  const showingTo = startIndex + currentRows.length;
  const paginationRange = useMemo(() => {
    const totalNumbers = 5;
    if (pageCount <= totalNumbers) {
      return Array.from({ length: pageCount }, (_, index) => index + 1);
    }

    const current = currentPage;
    const neighbours = 1;
    const showLeftEllipsis = current - neighbours > 2;
    const showRightEllipsis = current + neighbours < pageCount - 1;

    const range: Array<number | "ellipsis-left" | "ellipsis-right"> = [1];

    if (showLeftEllipsis) {
      range.push("ellipsis-left");
    }

    const start = Math.max(2, current - neighbours);
    const end = Math.min(pageCount - 1, current + neighbours);
    for (let i = start; i <= end; i += 1) {
      range.push(i);
    }

    if (showRightEllipsis) {
      range.push("ellipsis-right");
    }

    range.push(pageCount);

    return range;
  }, [currentPage, pageCount]);

  const fetchLatestFunding = useCallback(
    async (force = false) => {
      const hyperSymbols = hyperSymbolsRef.current;
      const binanceSymbols = binanceSymbolsRef.current;

      if (hyperSymbols.length === 0 && binanceSymbols.length === 0) {
        return;
      }

      const now = Date.now();
      if (!force && now - lastFetchRef.current < FETCH_INTERVAL_MS) {
        return;
      }

      if (isFetchingRef.current) {
        if (force) {
          await new Promise<void>((resolve) => {
            const check = () => {
              if (!isFetchingRef.current) {
                resolve();
              } else {
                window.setTimeout(check, 50);
              }
            };
            check();
          });
        }
        return;
      }

      isFetchingRef.current = true;
      try {
        const [hyperRates, binanceRates] = await Promise.all([
          fetchHyperliquidFundingRates(hyperSymbols),
          fetchBinanceFundingRates(binanceSymbols),
        ]);

        setLiveFunding({
          hyperliquid: hyperRates,
          binance: binanceRates,
        });
        lastFetchRef.current = Date.now();
      } catch {
        // ignore network errors; keep last values
      } finally {
        isFetchingRef.current = false;
      }
    },
    [],
  );

  const triggerBlockingRefresh = useCallback(() => {
    setIsBlockingRefresh(true);
    fetchLatestFunding(true).finally(() => setIsBlockingRefresh(false));
  }, [fetchLatestFunding]);

  const triggerCachedSortRefresh = useCallback(() => {
    if (Date.now() - lastFetchRef.current < SORT_REFRESH_CACHE_MS) {
      return;
    }
    triggerBlockingRefresh();
  }, [triggerBlockingRefresh]);

  const cycleSort = (column: SortColumn) => {
    if (sortColumn !== column) {
      setSortColumn(column);
      setSortDirection("desc");
      setPage(1);
      triggerCachedSortRefresh();
      return;
    }

    if (sortDirection === "desc") {
      setSortDirection("asc");
      setPage(1);
      triggerCachedSortRefresh();
      return;
    }

    setSortColumn(null);
    setSortDirection("desc");
    setPage(1);
    triggerCachedSortRefresh();
  };

  const handleHistoryDialogChange = (open: boolean) => {
    setHistoryDialogOpen(open);
    if (!open) {
      setHistoryTarget(null);
      setHistoryError(null);
      setHistoryLoading(false);
    }
  };

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex w-full max-w-xs items-center gap-2">
            <Input
              placeholder="搜索资产..."
              value={search}
              onChange={(event) => handleSearchChange(event.target.value)}
            />
            {search ? (
              <Button
                variant="outline"
                onClick={() => handleSearchChange("")}
                className="whitespace-nowrap"
              >
                清除
              </Button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              className="min-w-[110px]"
              onClick={triggerBlockingRefresh}
              disabled={isBlockingRefresh}
            >
              {isBlockingRefresh ? "刷新中…" : "刷新数据"}
            </Button>

            <span className="text-xs text-muted-foreground">
              资金费率均按 1 小时计
            </span>

            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline" size="icon" className="h-9 w-9">
                  <span className="sr-only">查看资金费率提示</span>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-5 w-5"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 16v-4" />
                    <path d="M12 8h.01" />
                  </svg>
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-md bg-slate-950 text-slate-100 sm:rounded-3xl">
                <DialogHeader>
                  <DialogTitle className="text-base font-semibold text-slate-100">
                    8 小时资金费率颜色提示
                  </DialogTitle>
                  <DialogDescription className="text-slate-400">
                    根据默认 8 小时资金费率区间渲染颜色。
                  </DialogDescription>
                </DialogHeader>
                <div className="mt-4 space-y-3 text-sm">
                  <div className="flex items-center justify-between gap-4">
                    <span>-∞ &lt; 8 小时费率 &lt; 0%</span>
                    <span className="h-4 w-4 rounded bg-[#f87171]" />
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <span>0% ≤ 8 小时费率 ≤ 0.01%</span>
                    <span className="h-4 w-4 rounded bg-[#94a3b8]" />
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <span>0.01% &lt; 8 小时费率</span>
                    <span className="h-4 w-4 rounded bg-[#34d399]" />
                  </div>
                </div>
              </DialogContent>
            </Dialog>

          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-3">
            <span className="font-medium text-foreground">显示资产：</span>
            <label className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
              <input
                type="radio"
                name="exchange-filter"
                value="intersection"
                checked={exchangeFilter === "intersection"}
                onChange={handleExchangeFilterChange}
                className="h-3 w-3 accent-foreground"
              />
              两边都有
            </label>
            <label className="flex items-center gap-1 text-xs font-normal text-muted-foreground">
              <input
                type="radio"
                name="exchange-filter"
                value="any"
                checked={exchangeFilter === "any"}
                onChange={handleExchangeFilterChange}
                className="h-3 w-3 accent-foreground"
              />
              任一存在
            </label>
          </div>
        </div>

        <div className="relative rounded-xl border">
          {isBlockingRefresh ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-background/80 backdrop-blur-sm">
              <div className="flex flex-col items-center gap-2 text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin" />
                <span className="text-xs font-medium">刷新…</span>
              </div>
            </div>
          ) : null}
          <Table className={cn("text-sm", isBlockingRefresh && "pointer-events-none opacity-50")}>
            <TableHeader>
              <TableRow className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <TableHead className="text-left font-semibold text-[11px] text-muted-foreground">
                  货币
                </TableHead>
                <TableHead className="text-left font-semibold text-[11px] text-muted-foreground">
                  <button
                    type="button"
                    onClick={() => cycleSort("markPrice")}
                    className="inline-flex w-full items-center justify-between gap-1 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground transition hover:text-primary focus:outline-none"
                  >
                    <span>价格</span>
                    {renderSortIcon("markPrice")}
                  </button>
                </TableHead>
                <TableHead className="text-left font-semibold text-[11px] text-muted-foreground">
                  1 小时
                </TableHead>
                <TableHead className="text-left font-semibold text-[11px] text-muted-foreground">
                  24 小时
                </TableHead>
                <TableHead className="text-left font-semibold text-[11px] text-muted-foreground">
                  7 天
                </TableHead>
                <TableHead className="text-left font-semibold text-[11px] text-muted-foreground">
                  <button
                    type="button"
                    onClick={() => cycleSort("maxLeverage")}
                    className="inline-flex w-full items-center justify-between gap-1 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground transition hover:text-primary focus:outline-none"
                  >
                    <span>最大杠杆</span>
                    {renderSortIcon("maxLeverage")}
                  </button>
                </TableHead>
                <TableHead className="text-left font-semibold text-[11px] text-muted-foreground">
                  <button
                    type="button"
                    onClick={() => cycleSort("funding")}
                    className="inline-flex w-full items-center justify-between gap-1 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground transition hover:text-primary focus:outline-none"
                  >
                    <span>{fundingColumnLabel}</span>
                    {renderSortIcon("funding")}
                  </button>
                </TableHead>
                <TableHead className="text-left font-semibold text-[11px] text-muted-foreground">
                  <button
                    type="button"
                    onClick={() => cycleSort("binanceFunding")}
                    className="inline-flex w-full items-center justify-between gap-1 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground transition hover:text-primary focus:outline-none"
                  >
                    <span>Binance 1 小时资金费率</span>
                    {renderSortIcon("binanceFunding")}
                  </button>
                </TableHead>
                <TableHead className="text-left font-semibold text-[11px] text-muted-foreground">
                  <button
                    type="button"
                    onClick={() => cycleSort("arbitrage")}
                    className="inline-flex w-full items-center justify-between gap-1 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground transition hover:text-primary focus:outline-none"
                  >
                    <span>套利空间（1 小时）</span>
                    {renderSortIcon("arbitrage")}
                  </button>
                </TableHead>
                <TableHead className="text-left font-semibold text-[11px] text-muted-foreground">
                  Hyperliquid 结算周期
                </TableHead>
                <TableHead className="text-left font-semibold text-[11px] text-muted-foreground">
                  Binance 结算周期
                </TableHead>
                <TableHead className="text-left font-semibold text-[11px] text-muted-foreground">
                  <button
                    type="button"
                    onClick={() => cycleSort("volumeHyperliquid")}
                    className="inline-flex w-full items-center justify-between gap-1 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground transition hover:text-primary focus:outline-none"
                  >
                    <span>Hyperliquid 24 小时成交量</span>
                    {renderSortIcon("volumeHyperliquid")}
                  </button>
                </TableHead>
                <TableHead className="text-left font-semibold text-[11px] text-muted-foreground">
                  <button
                    type="button"
                    onClick={() => cycleSort("volumeBinance")}
                    className="inline-flex w-full items-center justify-between gap-1 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground transition hover:text-primary focus:outline-none"
                  >
                    <span>Binance 24 小时成交量</span>
                    {renderSortIcon("volumeBinance")}
                  </button>
                </TableHead>
                <TableHead className="text-left font-semibold text-[11px] text-muted-foreground">
                  资金费率历史
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {currentRows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={14}
                    className="py-12 text-center text-sm text-muted-foreground"
                  >
                    未找到匹配的资产。
                  </TableCell>
                </TableRow>
              ) : (
                currentRows.map((row) => (
                  <PerpTableRow
                    key={row.symbol}
                    row={row}
                    liveFunding={liveFunding}
                    displayPeriodHours={displayPeriodHours}
                    hyperliquidSettlementLabel={hyperliquidSettlementLabel}
                    onHistoryClick={handleHistoryClick}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="text-sm text-muted-foreground">
            当前显示{" "}
            <span className="font-medium text-foreground">
              {showingFrom === 0 && showingTo === 0
                ? "0"
                : `${showingFrom}-${showingTo}`}
            </span>{" "}
            ，共{" "}
            <span className="font-medium text-foreground">{sortedLength}</span>{" "}
            个资产
          </div>
          <Pagination>
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  onClick={() => handlePageChange(currentPage - 1)}
                  aria-disabled={currentPage === 1}
                  className={cn(
                    currentPage === 1 && "pointer-events-none opacity-40",
                  )}
                />
              </PaginationItem>
              {paginationRange.map((value) => {
                if (value === "ellipsis-left" || value === "ellipsis-right") {
                  return (
                    <PaginationItem key={value}>
                      <PaginationEllipsis />
                    </PaginationItem>
                  );
                }

                return (
                  <PaginationItem key={value}>
                    <PaginationLink
                      isActive={currentPage === value}
                      onClick={() => handlePageChange(value)}
                    >
                      {value}
                    </PaginationLink>
                  </PaginationItem>
                );
              })}
              <PaginationItem>
                <PaginationNext
                  onClick={() => handlePageChange(currentPage + 1)}
                  aria-disabled={currentPage === pageCount}
                  className={cn(
                    currentPage === pageCount && "pointer-events-none opacity-40",
                  )}
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
      </div>
      <Dialog open={historyDialogOpen} onOpenChange={handleHistoryDialogChange}>
        <DialogContent className="w-[96vw] max-w-6xl">
          <DialogHeader>
            <DialogTitle>
              {historyTarget
                ? `${historyTarget.displayName} 资金费率历史`
                : "资金费率历史"}
            </DialogTitle>
            <DialogDescription>
              最近 {historyRangeMeta?.label ?? ""} Hyperliquid 与 Binance（若有）
              的资金费率对比（单位：%）。点击下方时间范围可切换。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            {HISTORY_OPTIONS.map((option) => {
              const isActive = option.value === historyRangeDays;
              return (
                <Button
                  key={option.value}
                  size="sm"
                  variant={isActive ? "default" : "outline"}
                  onClick={() => handleHistoryRangeChange(option.value)}
                  className={isActive ? "px-3" : "px-3"}
                >
                  {option.label}
                </Button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleHistoryZoom("in")}
              disabled={historyInteractionsDisabled}
            >
              放大
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleHistoryZoom("out")}
              disabled={historyInteractionsDisabled}
            >
              缩小
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleHistoryResetViewport}
              disabled={historyInteractionsDisabled || historyViewport === null}
            >
              重置视图
            </Button>
            <span className="text-xs text-muted-foreground">
              鼠标滚轮缩放，按住 Shift 或横向滚动可平移
            </span>
          </div>
          {historyLoading ? (
            <div className="flex h-72 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              加载历史数据…
            </div>
          ) : historyError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              {historyError}
            </div>
          ) : historyData?.length ? (
            <div
              className="h-[480px] w-full"
              ref={historyChartWrapperRef}
              onWheel={
                historyInteractionsDisabled ? undefined : handleHistoryWheel
              }
            >
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={historyData} margin={{ top: 12, right: 16, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" className="text-muted-foreground/20" />
                  <XAxis
                    dataKey="time"
                    type="number"
                    scale="time"
                    allowDataOverflow
                    tickFormatter={(value) => historyTickFormatter.format(value)}
                    domain={
                      historyXAxisDomain
                        ? [historyXAxisDomain[0], historyXAxisDomain[1]]
                        : ["dataMin", "dataMax"]
                    }
                    padding={{ left: 0, right: 0 }}
                    tickMargin={8}
                    fontSize={12}
                  />
                  <YAxis
                    tickFormatter={(value) => `${formatHistoryPercentValue(value)}%`}
                    fontSize={12}
                    width={60}
                  />
                  <ReferenceLine
                    y={0}
                    stroke="#334155"
                    strokeDasharray="6 4"
                    strokeWidth={2}
                    strokeOpacity={0.9}
                  />
                  <RechartsTooltip
                    formatter={(value, name) => {
                      const numericValue =
                        typeof value === "number"
                          ? value
                          : Number.parseFloat(String(value));
                      return [
                        formatHistoryTooltipValue(numericValue),
                        typeof name === "string" ? name : String(name ?? ""),
                      ];
                    }}
                    labelFormatter={(value) =>
                      historyTooltipFormatter.format(value as number)
                    }
                  />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="hyperliquid"
                    name="Hyperliquid"
                    stroke="#06b6d4"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                  <Line
                    type="monotone"
                    dataKey="binance"
                    name="Binance"
                    stroke="#f97316"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                  <Line
                    type="monotone"
                    dataKey="arbitrage"
                    name="套利空间（Hyper 多 / Binance 空）"
                    stroke="#ef4444"
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                  {historyBrushState && historyData && historyData.length > 1 ? (
                    <Brush
                      dataKey="time"
                      height={28}
                      stroke="#94a3b8"
                      travellerWidth={10}
                      tickFormatter={() => ""}
                      startIndex={historyBrushState.startIndex}
                      endIndex={historyBrushState.endIndex}
                      onChange={handleHistoryBrushChange}
                    />
                  ) : null}
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="rounded-md border border-border/60 bg-muted/40 px-4 py-6 text-center text-sm text-muted-foreground">
              暂无历史数据
            </div>
          )}
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}
