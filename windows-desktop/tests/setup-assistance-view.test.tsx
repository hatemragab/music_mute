// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SetupAssistancePanel } from "../src/renderer/setup-assistance-view.js";
import type { SetupAssistanceView } from "../src/shared/setup-assistance-contracts.js";
afterEach(cleanup);
const view: SetupAssistanceView = {
  state: "ready",
  busy: false,
  extension: "available",
  chrome: "available",
  modelFolder: "unavailable",
  problem: null,
};
it("keeps development guidance collapsed and sends closed assistance commands without exposing a folder or fabricated store destination", () => {
  const execute = vi.fn(async () => {});
  const { container } = render(
    <SetupAssistancePanel view={view} busy={false} execute={execute} />,
  );
  expect(container.querySelector("details")?.open).toBe(false);
  expect(container.querySelector("a")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Show voice model folder" }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Reveal extension folder" }),
  );
  expect(execute).toHaveBeenCalledWith({ type: "REVEAL_EXTENSION" });
  expect(container.textContent).not.toContain("C:\\Users");
});
it("busy or unavailable capabilities disable effects, and only explicit trusted model availability offers model reveal", () => {
  const execute = vi.fn(async () => {});
  const { rerender } = render(
    <SetupAssistancePanel
      view={{ ...view, busy: true, modelFolder: "available" }}
      busy={false}
      execute={execute}
    />,
  );
  for (const button of screen.getAllByRole("button"))
    expect((button as HTMLButtonElement).disabled).toBe(true);
  rerender(
    <SetupAssistancePanel
      view={{ ...view, extension: "unavailable", chrome: "unavailable" }}
      busy={false}
      execute={execute}
    />,
  );
  expect(screen.getByRole("alert").textContent).toContain(
    "could not be verified",
  );
  expect(
    screen.queryByRole("button", { name: "Show voice model folder" }),
  ).toBeNull();
  for (const button of screen.getAllByRole("button"))
    expect((button as HTMLButtonElement).disabled).toBe(true);
});
