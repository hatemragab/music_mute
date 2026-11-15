import type { UsageAmountView } from "./usage-contracts.js";
export function formatUsage(
  view: UsageAmountView,
  locale = "en",
  timeZone?: string,
): { percent: string; remaining: string; reset: string } {
  const percent = new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(view.usedPercent / 100);
  const hours = Math.floor(view.remainingSeconds / 3600),
    minutes = Math.floor((view.remainingSeconds % 3600) / 60),
    seconds = view.remainingSeconds % 60;
  const unit = (value: number, name: "hour" | "minute" | "second") =>
    new Intl.NumberFormat(locale, {
      style: "unit",
      unit: name,
      unitDisplay: "short",
      maximumFractionDigits: 0,
    }).format(value);
  const remaining = hours
    ? [unit(hours, "hour"), ...(minutes ? [unit(minutes, "minute")] : [])].join(
        " ",
      )
    : minutes
      ? [
          unit(minutes, "minute"),
          ...(seconds ? [unit(seconds, "second")] : []),
        ].join(" ")
      : unit(seconds, "second");
  return {
    percent,
    remaining,
    reset: new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timeZone ? { timeZone } : {}),
    }).format(new Date(view.resetAt)),
  };
}
