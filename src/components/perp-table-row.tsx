"use client";

/* eslint-disable @next/next/no-img-element */

import { memo } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  LineChart as LineChartIcon,
  Minus,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  TableCell,
  TableRow,
} from "@/components/ui/table";
import {
  describeFundingDirection,
  formatAnnualizedFunding,
  formatFundingRate,
  formatPercentChange,
  formatPrice,
  formatVolume,
  computeAnnualizedPercent,
} from "@/lib/formatters";
import { formatSettlementPeriod } from "@/lib/funding";
import type { MarketRow } from "@/types/market";
import { cn } from "@/lib/utils";

type LiveFundingMap = {
  hyperliquid: Record<string, number>;
  binance: Record<string, number>;
};

type PerpTableRowProps = {
  row: MarketRow;
  liveFunding: LiveFundingMap;
  displayPeriodHours: number;
  onHistoryClick: (row: MarketRow) => void;
  hyperliquidSettlementLabel: string;
};

const ARBITRAGE_COLOR_WINDOW_HOURS = 8;

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

function renderPriceChange(value: number | null) {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 0) {
      return (
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-500">
          <ArrowUpRight className="h-3 w-3" />
          {formatPercentChange(value)}
        </span>
      );
    }

    if (value < 0) {
      return (
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-500">
          <ArrowDownRight className="h-3 w-3" />
          {formatPercentChange(value)}
        </span>
      );
    }
  }

  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground tabular-nums">
      <Minus className="h-3 w-3" />
      {formatPercentChange(value)}
    </span>
  );
}

function PerpTableRowComponent({
  row,
  liveFunding,
  displayPeriodHours,
  onHistoryClick,
  hyperliquidSettlementLabel,
}: PerpTableRowProps) {
  const hyperliquidHourly =
    liveFunding.hyperliquid[row.symbol] ?? row.fundingRate;
  const aggregatedFunding = hyperliquidHourly * displayPeriodHours;
  const hyperEightHourFunding =
    hyperliquidHourly * ARBITRAGE_COLOR_WINDOW_HOURS;
  const binanceSettlementLabel = formatSettlementPeriod(
    row.binance?.fundingPeriodHours ?? null,
  );
  const marketUrl = `https://app.hyperliquid.xyz/trade/${encodeURIComponent(
    row.symbol,
  )}`;
  const coingeckoUrl = row.coingeckoId
    ? `https://www.coingecko.com/en/coins/${encodeURIComponent(
        row.coingeckoId,
      )}`
    : null;
  const binanceHourly =
    row.binance?.symbol != null
      ? liveFunding.binance[row.binance.symbol] ??
        row.binance.fundingRate ??
        null
      : null;
  const binanceFundingAggregated =
    binanceHourly !== null ? binanceHourly * displayPeriodHours : null;
  const binanceEightHourFunding =
    binanceHourly !== null
      ? binanceHourly * ARBITRAGE_COLOR_WINDOW_HOURS
      : null;
  const binanceVolume = row.binance?.volumeUsd ?? null;
  const hourlyArbDelta =
    binanceHourly !== null ? binanceHourly - hyperliquidHourly : null;
  const absArbDelta =
    hourlyArbDelta !== null ? Math.abs(hourlyArbDelta) : null;
  const colorArbDelta =
    hourlyArbDelta !== null
      ? hourlyArbDelta * ARBITRAGE_COLOR_WINDOW_HOURS
      : null;
  const colorAbsArbDelta =
    colorArbDelta !== null ? Math.abs(colorArbDelta) : null;

  let arbitrageBadgeClass =
    "border-border bg-muted/80 text-muted-foreground";
  let hyperDirClass = "text-muted-foreground";
  let binanceDirClass = "text-muted-foreground";
  let hyperDirLabel = "—";
  let binanceDirLabel = "—";
  const isSmallArbitrage =
    colorAbsArbDelta !== null && colorAbsArbDelta < 0.0001;

  if (colorArbDelta !== null) {
    if (colorArbDelta > 0) {
      hyperDirLabel = "做多";
      hyperDirClass = "text-emerald-500";
      binanceDirLabel = "做空";
      binanceDirClass = "text-red-500";
    } else if (colorArbDelta < 0) {
      hyperDirLabel = "做空";
      hyperDirClass = "text-red-500";
      binanceDirLabel = "做多";
      binanceDirClass = "text-emerald-500";
    }

    if (isSmallArbitrage) {
      arbitrageBadgeClass =
        "border-border bg-muted/80 text-muted-foreground";
    } else if (colorArbDelta > 0) {
      arbitrageBadgeClass =
        "border-emerald-200 bg-emerald-50 text-emerald-600";
    } else if (colorArbDelta < 0) {
      arbitrageBadgeClass = "border-red-200 bg-red-50 text-red-600";
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
        {binanceFundingAggregated !== null && row.binance?.symbol ? (
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
                    getFundingBadgeClass(binanceEightHourFunding ?? 0),
                  )}
                >
                  {formatFundingRate(binanceFundingAggregated)}
                </Badge>
              </a>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>{describeFundingDirection(binanceFundingAggregated)}</p>
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
                {isSmallArbitrage ? "套利空间（8h） < 0.01% · " : ""}
                Hyperliquid{" "}
                <span className={hyperDirClass}>{hyperDirLabel}</span> ·
                Binance <span className={binanceDirClass}>{binanceDirLabel}</span>
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
      <TableCell className="text-xs text-muted-foreground">
        {hyperliquidSettlementLabel}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {binanceSettlementLabel}
      </TableCell>
      <TableCell className="font-medium tabular-nums text-sm">
        {formatVolume(row.dayNotionalVolume)}
      </TableCell>
      <TableCell className="font-medium tabular-nums text-sm">
        {formatVolume(binanceVolume)}
      </TableCell>
      <TableCell className="text-xs">
        <Tooltip delayDuration={100}>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => onHistoryClick(row)}
              aria-label="查看资金费率历史"
            >
              <LineChartIcon className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">查看资金费率历史</TooltipContent>
        </Tooltip>
      </TableCell>
    </TableRow>
  );
}

export const PerpTableRow = memo(PerpTableRowComponent);
