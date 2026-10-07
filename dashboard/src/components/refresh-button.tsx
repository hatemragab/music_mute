import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

export function RefreshButton({
  label,
  refreshing,
  disabled = false,
  onRefresh,
}: {
  label: string;
  refreshing: boolean;
  disabled?: boolean;
  onRefresh(): void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-label={label}
      title={label}
      aria-busy={refreshing}
      disabled={disabled || refreshing}
      onClick={onRefresh}
    >
      <RefreshCw
        aria-hidden="true"
        className={
          refreshing ? "animate-spin motion-reduce:animate-none" : undefined
        }
      />
    </Button>
  );
}
