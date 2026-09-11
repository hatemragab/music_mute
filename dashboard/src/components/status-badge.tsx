import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const positive = new Set([
  "healthy",
  "online",
  "enabled",
  "completed",
  "verified",
  "published",
  "active",
  "succeeded",
]);
const negative = new Set([
  "unavailable",
  "offline",
  "revoked",
  "failed",
  "rejected",
  "critical",
  "disabled",
]);
const caution = new Set([
  "degraded",
  "draining",
  "processing",
  "queued",
  "warning",
  "cancel_requested",
  "deleting",
  "withdrawn",
]);

export function StatusBadge({
  value,
  label,
}: {
  value: string;
  label?: string;
}) {
  const normalized = value.toLowerCase();
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 whitespace-nowrap capitalize",
        positive.has(normalized) &&
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
        negative.has(normalized) &&
          "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
        caution.has(normalized) &&
          "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {label ?? value.replaceAll("_", " ")}
    </Badge>
  );
}
