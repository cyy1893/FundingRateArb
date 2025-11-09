"use client";

/* eslint-disable @next/next/no-img-element */

import {
  ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  Loader2,
  Minus,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  FUNDING_PERIOD_OPTIONS,
} from "@/lib/funding";
import { cn } from "@/lib/utils";
import {
  formatFundingRate,
  formatPrice,
  formatVolume,
  describeFundingDirection,
  formatAnnualizedFunding,
  computeAnnualizedPercent,
  formatPercentChange,
} from "@/lib/formatters";
import type { MarketRow } from "@/types/market";

type PerpTableProps = {
  rows: MarketRow[];
  pageSize?: number;
  defaultPeriodHours?: number;
};

const DEFAULT_PAGE_SIZE = 25;
const FETCH_INTERVAL_MS = 15000;
const SORT_REFRESH_CACHE_MS = 5000;

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

const RATE_THRESHOLDS = {
  negative: 0,
  neutralUpperBound: 0.0001,
} as const;

function getFundingBadgeClass(rate: number): string {
  if (rate < RATE_THRESHOLDS.negative) {
    return "border-[#fb7185]/60 bg-[#f87171]/10 text-[#b91c1c]";
  }

  if (rate <= RATE_THRESHOLDS.neutralUpperBound) {
    return "border-[#cbd5f5] bg-[#cbd5f51a] text-[#475569]";
  }

  return "border-[#6ee7b7] bg-[#6ee7b71a] text-[#047857]";
}

export function PerpTable({
  rows,
  pageSize = DEFAULT_PAGE_SIZE,
  defaultPeriodHours = DEFAULT_FUNDING_PERIOD_HOURS,
}: PerpTableProps) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [periodHours, setPeriodHours] = useState(defaultPeriodHours);
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
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [isBlockingRefresh, setIsBlockingRefresh] = useState(false);

  const normalizedSearch = search.trim().toLowerCase();

  const filteredRows = useMemo(() => {
    const matchesSearch = (row: MarketRow) =>
      row.symbol.toLowerCase().includes(normalizedSearch);

    const matchesExchange = (row: MarketRow) =>
      exchangeFilter === "intersection" ? Boolean(row.binance) : true;

    return rows.filter((row) => matchesSearch(row) && matchesExchange(row));
  }, [normalizedSearch, rows, exchangeFilter]);

  const periodOption =
    FUNDING_PERIOD_OPTIONS.find((option) => option.value === periodHours) ??
    FUNDING_PERIOD_OPTIONS[0];
  const periodLabel = periodOption.label;
  const fundingColumnLabel = `Hyperliquid 资金费率`;

  const handlePageChange = (nextPage: number) => {
    if (nextPage >= 1 && nextPage <= pageCount) {
      setPage(nextPage);
    }
  };

  const handleSearchChange = (value: string) => {
    setSearch(value);
    setPage(1);
  };

  const handlePeriodChange = (value: string) => {
    const parsed = Number.parseInt(value, 10);

    if (!Number.isNaN(parsed)) {
      setPeriodHours(parsed);
      setPage(1);
    }
  };

  const handleExchangeFilterChange = (event: ChangeEvent<HTMLInputElement>) => {
    setExchangeFilter(event.target.value as ExchangeFilter);
    setPage(1);
  };

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
          return funding * periodHours;
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

          const hyperliquidEightHour =
            liveHyper * DEFAULT_FUNDING_PERIOD_HOURS;
          const binanceEightHour = binanceHourly * DEFAULT_FUNDING_PERIOD_HOURS;
          return Math.abs(hyperliquidEightHour - binanceEightHour);
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
  }, [filteredRows, sortColumn, sortDirection, periodHours, liveFunding]);

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

  const renderPriceChange = (value: number | null) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
          —
        </span>
      );
    }

    if (value > 0) {
      return (
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-500 tabular-nums">
          <ArrowUpRight className="h-3 w-3" />
          {formatPercentChange(value)}
        </span>
      );
    }

    if (value < 0) {
      return (
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-rose-500 tabular-nums">
          <ArrowDownRight className="h-3 w-3" />
          {formatPercentChange(value)}
        </span>
      );
    }

    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground tabular-nums">
        <Minus className="h-3 w-3" />
        {formatPercentChange(value)}
      </span>
    );
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
        setLastRefresh(new Date());
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

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="min-w-[120px] justify-between"
                >
                  <span>{periodLabel}</span>
                  <ChevronDown className="h-4 w-4 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-36">
                <DropdownMenuRadioGroup
                  value={String(periodHours)}
                  onValueChange={handlePeriodChange}
                >
                  {FUNDING_PERIOD_OPTIONS.map((option) => (
                    <DropdownMenuRadioItem
                      key={option.value}
                      value={String(option.value)}
                    >
                      {option.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>

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
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground">当前资金周期：</span>
            <Badge variant="secondary" className="bg-muted/70">
              {periodLabel}
            </Badge>
          </div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
            <span>最近更新</span>
            <span className="font-medium text-foreground tabular-nums">
              {lastRefresh
                ? lastRefresh.toLocaleTimeString("en-US", {
                    hour12: false,
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })
                : "—"}
            </span>
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
                  <span>Binance 资金费率</span>
                  {renderSortIcon("binanceFunding")}
                </button>
              </TableHead>
              <TableHead className="text-left font-semibold text-[11px] text-muted-foreground">
                <button
                  type="button"
                  onClick={() => cycleSort("arbitrage")}
                  className="inline-flex w-full items-center justify-between gap-1 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground transition hover:text-primary focus:outline-none"
                >
                  <span>套利空间（8 小时）</span>
                  {renderSortIcon("arbitrage")}
                </button>
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
              </TableRow>
            </TableHeader>
            <TableBody>
              {currentRows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={11}
                    className="py-12 text-center text-sm text-muted-foreground"
                  >
                    未找到匹配的资产。
                  </TableCell>
                </TableRow>
              ) : (
                currentRows.map((row) => {
                  const hyperliquidHourly =
                    liveFunding.hyperliquid[row.symbol] ?? row.fundingRate;
                  const aggregatedFunding = hyperliquidHourly * periodHours;
                  const hyperEightHourFunding =
                    hyperliquidHourly * DEFAULT_FUNDING_PERIOD_HOURS;
                  const marketUrl = `https://app.hyperliquid.xyz/trade/${encodeURIComponent(
                    row.symbol,
                  )}`;
                  const coingeckoUrl = row.coingeckoId
                    ? `https://www.coingecko.com/en/coins/${encodeURIComponent(
                        row.coingeckoId,
                      )}`
                    : null;
                  const binanceHourly =
                    row.binance?.symbol
                      ? liveFunding.binance[row.binance.symbol] ??
                        row.binance.fundingRate ??
                        null
                      : null;
                const binanceFundingAggregated =
                  binanceHourly !== null ? binanceHourly * periodHours : null;
                const binanceEightHourFunding =
                  binanceHourly !== null
                    ? binanceHourly * DEFAULT_FUNDING_PERIOD_HOURS
                    : null;
                const binanceVolume = row.binance?.volumeUsd ?? null;
                const arbDelta =
                  binanceEightHourFunding !== null
                    ? hyperEightHourFunding - binanceEightHourFunding
                    : null;
                const absArbDelta =
                  arbDelta !== null ? Math.abs(arbDelta) : null;

                let arbitrageBadgeClass =
                  "border-border bg-muted/80 text-muted-foreground";
                let hyperDirClass = "text-muted-foreground";
                let binanceDirClass = "text-muted-foreground";
                let hyperDirLabel = "—";
                let binanceDirLabel = "—";
                const isSmallArbitrage =
                  absArbDelta !== null && absArbDelta < 0.0001;

                if (arbDelta !== null) {
                  if (arbDelta > 0) {
                    hyperDirLabel = "做空";
                    hyperDirClass = "text-red-500";
                    binanceDirLabel = "做多";
                    binanceDirClass = "text-emerald-500";
                  } else if (arbDelta < 0) {
                    hyperDirLabel = "做多";
                    hyperDirClass = "text-emerald-500";
                    binanceDirLabel = "做空";
                    binanceDirClass = "text-red-500";
                  }

                  if (isSmallArbitrage) {
                    arbitrageBadgeClass =
                      "border-border bg-muted/80 text-muted-foreground";
                  } else if (arbDelta > 0) {
                    arbitrageBadgeClass =
                      "border-red-200 bg-red-50 text-red-600";
                  } else if (arbDelta < 0) {
                    arbitrageBadgeClass =
                      "border-emerald-200 bg-emerald-50 text-emerald-600";
                  }
                }

                return (
                  <TableRow key={row.symbol} className="hover:bg-muted/40">
                    <TableCell className="py-3 text-sm font-semibold text-foreground min-w-[190px]">
                      {coingeckoUrl ? (
                        <div className="flex items-center gap-2.5">
                          <a
                            href={coingeckoUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-border/30 bg-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                          >
                            {row.iconUrl ? (
                              <img
                                src={row.iconUrl}
                                alt={`${row.displayName} 图标`}
                                className="h-full w-full rounded-full object-contain"
                                loading="lazy"
                              />
                            ) : (
                              <span className="text-[10px] font-medium uppercase text-muted-foreground">
                                {row.symbol.slice(0, 3)}
                              </span>
                            )}
                          </a>
                          <div className="flex flex-col overflow-hidden">
                            <a
                              href={coingeckoUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="truncate text-sm font-semibold text-foreground transition hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                            >
                              {row.displayName}
                            </a>
                            <span className="truncate text-[11px] uppercase text-muted-foreground">
                              {row.symbol}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2.5">
                          {row.iconUrl ? (
                            <img
                              src={row.iconUrl}
                              alt={`${row.displayName} 图标`}
                              className="h-7 w-7 flex-shrink-0 rounded-full border border-border/30 bg-background object-contain"
                              loading="lazy"
                            />
                          ) : (
                            <div className="flex h-7 w-7 items-center justify-center rounded-full border border-border/60 bg-muted text-[10px] font-medium uppercase text-muted-foreground">
                              {row.symbol.slice(0, 3)}
                            </div>
                          )}
                          <div className="flex flex-col overflow-hidden">
                            <span className="truncate text-sm font-semibold text-foreground">
                              {row.displayName}
                            </span>
                            <span className="truncate text-[11px] uppercase text-muted-foreground">
                              {row.symbol}
                            </span>
                          </div>
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="font-medium tabular-nums text-sm">
                      {formatPrice(row.markPrice)}
                    </TableCell>
                    <TableCell className="text-xs font-medium">
                      {renderPriceChange(row.priceChange1h)}
                    </TableCell>
                    <TableCell className="text-xs font-medium">
                      {renderPriceChange(row.priceChange24h)}
                    </TableCell>
                    <TableCell className="text-xs font-medium">
                      {renderPriceChange(row.priceChange7d)}
                    </TableCell>
                    <TableCell className="font-medium tabular-nums text-sm">
                      {row.maxLeverage}倍
                    </TableCell>
                    <TableCell>
                        <Tooltip delayDuration={100}>
                          <TooltipTrigger asChild>
                            <a
                              href={marketUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex"
                            >
                              <Badge
                                variant="secondary"
                                className={cn(
                                  "font-medium text-xs",
                                  getFundingBadgeClass(hyperEightHourFunding),
                                )}
                              >
                                {formatFundingRate(aggregatedFunding)}
                              </Badge>
                            </a>
                          </TooltipTrigger>
                          <TooltipContent side="top">
                            <p>{describeFundingDirection(aggregatedFunding)}</p>
                            <p className="mt-1 text-[10px] text-muted-foreground">
                              {formatAnnualizedFunding(hyperliquidHourly)}
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      </TableCell>
                      <TableCell>
                        {binanceFundingAggregated !== null &&
                        row.binance?.symbol ? (
                          <Tooltip delayDuration={100}>
                            <TooltipTrigger asChild>
                              <a
                                href={`https://www.binance.com/zh-CN/futures/${row.binance.symbol}`}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex"
                              >
                                <Badge
                                  variant="secondary"
                                  className={cn(
                                    "font-medium text-xs",
                                    getFundingBadgeClass(
                                      binanceEightHourFunding ?? 0,
                                    ),
                                  )}
                                >
                                  {formatFundingRate(binanceFundingAggregated)}
                                </Badge>
                              </a>
                            </TooltipTrigger>
                            <TooltipContent side="top">
                              <p>
                                {describeFundingDirection(
                                  binanceFundingAggregated,
                                )}
                              </p>
                              <p className="mt-1 text-[10px] text-muted-foreground">
                                {formatAnnualizedFunding(binanceHourly ?? 0)}
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <Badge
                            variant="secondary"
                            className="font-medium text-xs border-border bg-muted/80 text-muted-foreground"
                          >
                            —
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {absArbDelta !== null ? (
                      <Tooltip delayDuration={100}>
                        <TooltipTrigger asChild>
                          <Badge
                            variant="secondary"
                            className={cn("font-medium text-xs", arbitrageBadgeClass)}
                          >
                            {formatFundingRate(absArbDelta)}
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          <p className="text-[10px] text-muted-foreground">
                            {isSmallArbitrage ? "套利空间 < 0.01% · " : ""}
                            Hyperliquid{" "}
                            <span className={hyperDirClass}>
                              {hyperDirLabel}
                            </span>{" "}
                            · Binance{" "}
                            <span className={binanceDirClass}>
                              {binanceDirLabel}
                            </span>
                          </p>
                          <p className="mt-1 text-[10px] text-muted-foreground">
                            年化 {computeAnnualizedPercent(absArbDelta)}
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <Badge
                        variant="secondary"
                        className="font-medium text-xs border-border bg-muted/80 text-muted-foreground"
                          >
                            —
                          </Badge>
                        )}
                      </TableCell>
                  <TableCell className="font-medium">
                    {row.dayNotionalVolume !== null
                      ? formatVolume(row.dayNotionalVolume)
                      : "—"}
                  </TableCell>
                  <TableCell className="font-medium">
                    {binanceVolume !== null ? formatVolume(binanceVolume) : "—"}
                  </TableCell>
                </TableRow>
              );
            })
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
    </TooltipProvider>
  );
}
