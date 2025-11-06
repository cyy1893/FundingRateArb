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
  maximumFractionDigits: 2,
});

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
  const formatted =
    Math.abs(percentValue) >= 0.001
      ? percentValue.toFixed(3)
      : percentValue.toFixed(5);
  return `${formatted.replace(/\.?0+$/, "")}%`;
}

export function describeFundingDirection(rate: number): string {
  if (!Number.isFinite(rate) || rate === 0) {
    return "多空平衡";
  }

  return rate > 0 ? "多头向空头支付" : "空头向多头支付";
}

export function formatAnnualizedFunding(rate: number): string {
  if (!Number.isFinite(rate)) {
    return "年化 —";
  }

  const annualized = Math.abs(rate) * 3 * 365 * 100;
  const formatted =
    Math.abs(annualized) >= 0.01
      ? annualized.toFixed(3)
      : annualized.toFixed(5);
  return `年化 ${formatted.replace(/\.?0+$/, "")}%`;
}

export function computeAnnualizedPercent(rate: number): string {
  if (!Number.isFinite(rate)) {
    return "—";
  }

  const annualized = Math.abs(rate) * 3 * 365 * 100;
  const formatted =
    Math.abs(annualized) >= 0.01
      ? annualized.toFixed(3)
      : annualized.toFixed(5);
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
