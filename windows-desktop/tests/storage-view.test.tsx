// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StoragePanel } from "../src/renderer/storage-view.js";
import type { StorageView } from "../src/shared/storage-contracts.js";
afterEach(cleanup);
const ready: StorageView = {
  state: "ready",
  errorCode: null,
  budgetBytes: 2_000_000_000,
  voicesBytes: 0,
  reservedVoicesBytes: 0,
  freeBytes: 10_000_000_000,
  overBudget: false,
  lowSpace: false,
  categories: [],
  lastCleanup: null,
};
it("preserves an unsaved storage draft through incoming scans and confirms only the actual saved budget", () => {
  const execute = vi.fn(async () => {}),
    r = render(<StoragePanel view={ready} busy={false} execute={execute} />);
  const input = screen.getByLabelText(
    "Offline voice storage limit in GB",
  ) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "7" } });
  r.rerender(
    <StoragePanel
      view={{ ...ready, state: "loading" }}
      busy={false}
      execute={execute}
    />,
  );
  r.rerender(
    <StoragePanel
      view={{ ...ready, voicesBytes: 100 }}
      busy={false}
      execute={execute}
    />,
  );
  expect(
    (
      screen.getByLabelText(
        "Offline voice storage limit in GB",
      ) as HTMLInputElement
    ).value,
  ).toBe("7");
  fireEvent.click(screen.getByRole("button", { name: "Save storage limit" }));
  expect(execute).toHaveBeenCalledWith({
    type: "SET_BUDGET",
    budgetBytes: 7_000_000_000,
  });
  r.rerender(
    <StoragePanel
      view={{ ...ready, budgetBytes: 4_000_000_000 }}
      busy={false}
      execute={execute}
    />,
  );
  expect(
    (
      screen.getByLabelText(
        "Offline voice storage limit in GB",
      ) as HTMLInputElement
    ).value,
  ).toBe("7");
  r.rerender(
    <StoragePanel
      view={{ ...ready, budgetBytes: 7_000_000_000 }}
      busy={false}
      execute={execute}
    />,
  );
  expect(
    (
      screen.getByLabelText(
        "Offline voice storage limit in GB",
      ) as HTMLInputElement
    ).value,
  ).toBe("7");
});
it("validates Arabic whole-GB input and leaves an invalid draft intact instead of saving it", () => {
  const execute = vi.fn(async () => {});
  render(<StoragePanel view={ready} busy={false} execute={execute} />);
  const input = screen.getByLabelText("Offline voice storage limit in GB");
  fireEvent.change(input, { target: { value: "٣" } });
  fireEvent.click(screen.getByRole("button", { name: "Save storage limit" }));
  expect(execute).toHaveBeenCalledWith({
    type: "SET_BUDGET",
    budgetBytes: 3_000_000_000,
  });
  fireEvent.change(input, { target: { value: "1.5" } });
  expect(
    (
      screen.getByRole("button", {
        name: "Save storage limit",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect((input as HTMLInputElement).value).toBe("1.5");
});
