// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OutboxPanel } from "../src/renderer/outbox-view.js";
import type { OutboxView } from "../src/shared/outbox-contracts.js";
afterEach(cleanup);
const view: OutboxView = {
  authenticated: true,
  busy: false,
  errorCode: null,
  items: [
    {
      requestId: "00000000-0000-4000-8000-000000000001",
      localId: "local:one",
      kind: "pair",
      state: "retry",
      title: "Saved voice",
      errorCode: "OFFLINE",
      jobId: null,
      nextAttemptAt: 1,
    },
  ],
};
it("hides owner-specific pending saves while signed out", () => {
  render(
    <OutboxPanel
      view={{ ...view, authenticated: false }}
      busy={false}
      execute={vi.fn()}
    />,
  );
  expect(screen.queryByText("Saved voice")).toBeNull();
});
it("retries the durable request and requires explicit discard confirmation", () => {
  const execute = vi.fn(async () => {});
  render(<OutboxPanel view={view} busy={false} execute={execute} />);
  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  expect(execute).toHaveBeenLastCalledWith({
    type: "RETRY",
    requestId: view.items[0]!.requestId,
  });
  fireEvent.click(screen.getByRole("button", { name: "Discard pending save" }));
  expect(execute).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Confirm discard" }));
  expect(execute).toHaveBeenLastCalledWith({
    type: "DISCARD",
    requestId: view.items[0]!.requestId,
  });
});
