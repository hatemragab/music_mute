import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  parseDateRange,
  validateDateRange,
  type DateRange,
} from "./date-range";
import { DateRangeFilter } from "./date-range-filter";

const fallback: DateRange = {
  from: "2026-09-01T00:00:00.000Z",
  to: "2026-09-07T23:59:59.999Z",
};

describe("date ranges", () => {
  it("falls back instead of crashing on invalid URL values", () => {
    expect(parseDateRange("not-a-date", "also-invalid", fallback)).toEqual(
      fallback,
    );
  });

  it("rejects backward and greater-than-90-day ranges", () => {
    expect(
      validateDateRange({
        from: "2026-09-08T00:00:00.000Z",
        to: "2026-09-07T23:59:59.999Z",
      }),
    ).toMatch(/after/i);
    expect(
      validateDateRange({
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-09-07T23:59:59.999Z",
      }),
    ).toMatch(/90 days/i);
  });

  it("does not throw or submit an invalid range when a date is cleared", async () => {
    const change = vi.fn();
    const user = userEvent.setup();
    render(<DateRangeFilter range={fallback} onChange={change} />);

    await user.clear(screen.getByLabelText("From"));

    expect(change).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/valid date/i);
  });
});
