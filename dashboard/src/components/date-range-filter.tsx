import { useMemo, useState } from "react";
import { CalendarDays } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createRange,
  validateDateRange,
  type DateRange,
} from "@/components/date-range";

export function DateRangeFilter({
  range,
  onChange,
}: {
  range: DateRange;
  onChange(range: DateRange): void;
}) {
  const [error, setError] = useState<string | null>(null);
  const values = useMemo(
    () => ({ from: range.from.slice(0, 10), to: range.to.slice(0, 10) }),
    [range],
  );
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-card p-2">
      <CalendarDays
        aria-hidden="true"
        className="mb-2 ml-1 size-4 text-muted-foreground"
      />
      {[1, 7, 30].map((days) => (
        <Button
          key={days}
          size="sm"
          variant="ghost"
          onClick={() => {
            setError(null);
            onChange(createRange(days));
          }}
        >
          {days === 1 ? "Today" : `${days} days`}
        </Button>
      ))}
      <label className="grid gap-1 text-xs text-muted-foreground">
        From
        <Input
          className="h-8"
          type="date"
          value={values.from}
          aria-invalid={Boolean(error)}
          onChange={(event) => {
            if (!event.target.value) {
              setError("Choose a valid date.");
              return;
            }
            const next = {
              ...range,
              from: `${event.target.value}T00:00:00.000Z`,
            };
            const message = validateDateRange(next);
            setError(message);
            if (!message) onChange(next);
          }}
        />
      </label>
      <label className="grid gap-1 text-xs text-muted-foreground">
        To
        <Input
          className="h-8"
          type="date"
          value={values.to}
          aria-invalid={Boolean(error)}
          onChange={(event) => {
            if (!event.target.value) {
              setError("Choose a valid date.");
              return;
            }
            const next = {
              ...range,
              to: `${event.target.value}T23:59:59.999Z`,
            };
            const message = validateDateRange(next);
            setError(message);
            if (!message) onChange(next);
          }}
        />
      </label>
      {error ? (
        <p role="alert" className="basis-full text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
