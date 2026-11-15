// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PreparePanel } from "../src/renderer/prepare-view.js";
import type { PrepareView } from "../src/shared/prepare-contracts.js";
afterEach(cleanup);
const view: PrepareView = {
  state: "preparing",
  stage: "gpu",
  percent: null,
  completedBytes: null,
  totalBytes: null,
  requiredBytes: null,
  availableBytes: null,
  errorCode: null,
  browser: "unknown",
};
it("shows indeterminate GPU work and cancellation without inventing progress", () => {
  const execute = vi.fn(async () => {});
  render(
    <PreparePanel
      view={view}
      message="Preparing"
      busy={false}
      execute={execute}
    />,
  );
  expect(screen.getByRole("progressbar").hasAttribute("value")).toBe(false);
  expect(screen.getByRole("status").textContent).toBe("Testing GPU processing");
  fireEvent.click(screen.getByRole("button", { name: "Cancel preparation" }));
  expect(execute).toHaveBeenCalledWith("cancel");
});
it("shows safe error, measured bytes and retry/repair when qualification fails", () => {
  const execute = vi.fn(async () => {});
  render(
    <PreparePanel
      view={{
        ...view,
        state: "error",
        errorCode: "GPU_UNSUPPORTED",
        requiredBytes: 1024 ** 3,
        availableBytes: 2 * 1024 ** 3,
      }}
      message="Preparation needs attention"
      busy={false}
      execute={execute}
    />,
  );
  expect(screen.getByRole("alert").textContent).toContain("graphics driver");
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.getByText(/1.00 GB required/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry preparation" }));
  expect(execute).toHaveBeenCalledWith("start");
  fireEvent.click(screen.getByRole("button", { name: "Repair preparation" }));
  expect(execute).toHaveBeenCalledWith("repair");
});
it("keeps Chrome registration repair separate from qualified local GPU readiness", () => {
  render(
    <PreparePanel
      view={{
        ...view,
        state: "ready",
        stage: null,
        browser: "attention-needed",
      }}
      message="Local GPU processing is ready"
      busy={false}
      execute={async () => {}}
    />,
  );
  expect(screen.getByText(/Chrome connection needs repair/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Prepare this PC" })).toBeNull();
});
it("exposes readonly readiness checking separately from preparation and repair", () => {
  const execute = vi.fn(async () => {});
  const { rerender } = render(
    <PreparePanel
      view={{ ...view, state: "ready", stage: null }}
      message="Local GPU processing is ready."
      busy={false}
      execute={execute}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Check readiness" }));
  expect(execute).toHaveBeenCalledWith("check");
  expect(execute).not.toHaveBeenCalledWith("start");
  rerender(
    <PreparePanel
      view={view}
      message="Preparing"
      busy={false}
      execute={execute}
    />,
  );
  expect(screen.queryByRole("button", { name: "Check readiness" })).toBeNull();
});
