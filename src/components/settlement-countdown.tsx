"use client";

import { useEffect, useMemo, useState } from "react";

import { MS_PER_HOUR, MS_PER_MINUTE } from "@/lib/funding";
import { cn } from "@/lib/utils";

type SettlementCountdownProps = {
  targetIso: string;
  className?: string;
};

function rollForward(currentMs: number, initialTargetMs: number): number {
  if (!Number.isFinite(initialTargetMs)) {
    return currentMs + MS_PER_HOUR;
  }

  if (currentMs < initialTargetMs) {
    return initialTargetMs;
  }

  const elapsed = currentMs - initialTargetMs;
  const periodsToAdd = Math.floor(elapsed / MS_PER_HOUR) + 1;
  return initialTargetMs + periodsToAdd * MS_PER_HOUR;
}

export function SettlementCountdown({
  targetIso,
  className,
}: SettlementCountdownProps) {
  const baseTargetMs = useMemo(() => {
    const parsed = new Date(targetIso).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }, [targetIso]);

  const [nowMs, setNowMs] = useState<number | null>(null);

  useEffect(() => {
    const update = () => setNowMs(Date.now());
    update();
    const intervalId = window.setInterval(update, 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  if (nowMs === null) {
    return (
      <span className={cn("tabular-nums font-semibold text-foreground", className)}>
        --时 --分 --秒
      </span>
    );
  }

  const targetMs = rollForward(nowMs, baseTargetMs);
  const diffMs = Math.max(0, targetMs - nowMs);
  const hours = Math.floor(diffMs / MS_PER_HOUR);
  const minutes = Math.floor((diffMs % MS_PER_HOUR) / MS_PER_MINUTE);
  const seconds = Math.floor((diffMs % MS_PER_MINUTE) / 1000);

  const format = (value: number, suffix: string, pad: boolean = false) =>
    `${pad ? value.toString().padStart(2, "0") : value}${suffix}`;

  return (
    <span className={cn("tabular-nums font-semibold text-foreground", className)}>
      {`${format(hours, "小时")} ${format(minutes, "分", true)} ${format(
        seconds,
        "秒",
        true,
      )}`}
    </span>
  );
}
