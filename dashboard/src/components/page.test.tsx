import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RefreshButton } from "./page";

describe("RefreshButton", () => {
  it("runs a manual refresh", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    render(<RefreshButton onRefresh={onRefresh} />);

    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("prevents duplicate refreshes while a request is in flight", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    render(<RefreshButton refreshing onRefresh={onRefresh} />);

    const button = screen.getByRole("button", { name: "Refreshing" });
    expect(button).toBeDisabled();
    await user.click(button);

    expect(onRefresh).not.toHaveBeenCalled();
  });
});
