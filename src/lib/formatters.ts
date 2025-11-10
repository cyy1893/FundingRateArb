import { DEFAULT_FUNDING_PERIOD_HOURS } from "./funding";

const priceFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const smallPriceFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 5,
});

const compactUsdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const percentSigFormatter = new Intl.NumberFormat("en-US", {
  minimumSignificantDigits: 1,
  maximumSignificantDigits: 3,
  useGrouping: false,
});

const HOURS_PER_DAY = 24;
const DAYS_PER_YEAR = 365;

export function formatPrice(value: number): string {
  if (!Number.isFinite(value)) {
    return "—";
  }

  if (value >= 1000) {
    return ensureUsdPrefix(priceFormatter.format(value));
  }

  if (value >= 1) {
    const formatted = value.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 3,
    });
    return `US$${formatted}`;
  }

  return `US$${smallPriceFormatter.format(value)}`;
}

function ensureUsdPrefix(formatted: string): string {
  return formatted.startsWith("$") ? `US$${formatted.slice(1)}` : formatted;
}

export function formatVolume(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "—";
  }

  if (value < 1000) {
    return ensureUsdPrefix(priceFormatter.format(value));
  }

  return ensureUsdPrefix(compactUsdFormatter.format(value));
}

export function formatFundingRate(rate: number): string {
  if (!Number.isFinite(rate)) {
    return "—";
  }

  const percentValue = rate * 100;
  const formatted = percentSigFormatter.format(percentValue);
  return `${formatted}%`;
}

export function describeFundingDirection(rate: number): string {
  if (!Number.isFinite(rate) || rate === 0) {
    return "多空平衡";
  }

  return rate > 0 ? "多头向空头支付" : "空头向多头支付";
}

export function formatAnnualizedFunding(
  rate: number,
  intervalHours: number = 1,
): string {
  if (
    !Number.isFinite(rate) ||
    !Number.isFinite(intervalHours) ||
    intervalHours <= 0
  ) {
    return "年化 —";
  }

  const periodsPerYear = (HOURS_PER_DAY / intervalHours) * DAYS_PER_YEAR;
  const annualized = Math.abs(rate) * periodsPerYear * 100;
  const formatted =
    Math.abs(annualized) >= 0.01 ? annualized.toFixed(3) : annualized.toFixed(5);
  return `年化 ${formatted.replace(/\.?0+$/, "")}%`;
}

export function computeAnnualizedPercent(
  rate: number,
  periodHours: number = DEFAULT_FUNDING_PERIOD_HOURS,
): string {
  if (
    !Number.isFinite(rate) ||
    !Number.isFinite(periodHours) ||
    periodHours <= 0
  ) {
    return "—";
  }

  const periodsPerYear = (HOURS_PER_DAY / periodHours) * DAYS_PER_YEAR;
  const annualized = Math.abs(rate) * periodsPerYear * 100;
  const formatted =
    Math.abs(annualized) >= 0.01 ? annualized.toFixed(3) : annualized.toFixed(5);
  return `${formatted.replace(/\.?0+$/, "")}%`;
}

export function formatPercentChange(
  value: number | null | undefined,
  fractionDigits: number = 2,
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "0%";
  }

  const absolute = Math.abs(value);
  const formatted = absolute.toFixed(fractionDigits).replace(/\.?0+$/, "");

  if (value > 0) {
    return `+${formatted}%`;
  }

  if (value < 0) {
    return `-${formatted}%`;
  }

  return "0%";
}
