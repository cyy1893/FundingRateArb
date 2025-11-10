export const DEFAULT_FUNDING_PERIOD_HOURS = 1;

export type FundingPeriodOption = {
  label: string;
  value: number;
};

export const FUNDING_PERIOD_OPTIONS: FundingPeriodOption[] = [
  { label: "每小时", value: 1 },
  {
    label: `${DEFAULT_FUNDING_PERIOD_HOURS}小时`,
    value: DEFAULT_FUNDING_PERIOD_HOURS,
  },
];

export const MS_PER_HOUR = 60 * 60 * 1000;

export function formatSettlementPeriod(
  hours: number | null | undefined,
): string {
  if (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0) {
    return "—";
  }

  const label = Number.isInteger(hours)
    ? hours.toString()
    : hours.toFixed(2).replace(/\.?0+$/, "");

  return `${label} 小时`;
}
export const MS_PER_MINUTE = 60 * 1000;

export function computeNextSettlementTimestamp(
  baseDate: Date,
  periodHours: number = 1,
): string {
  if (!Number.isFinite(periodHours) || periodHours <= 0) {
    return baseDate.toISOString();
  }

  const period = Math.max(1, Math.floor(periodHours));
  const utcMs = baseDate.getTime();
  const nextSettlementMs =
    Math.ceil(utcMs / (period * MS_PER_HOUR)) * period * MS_PER_HOUR;

  return new Date(nextSettlementMs).toISOString();
}
