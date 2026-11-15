// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConsumerUpdatePanel } from "../src/renderer/update-view.js";
import type {
  ConsumerUpdateView,
  ConsumerUpdateCommand,
} from "../src/shared/update-contracts.js";
import { setLanguage } from "../src/renderer/i18n.js";
afterEach(() => {
  cleanup();
  setLanguage("en");
});
const available: ConsumerUpdateView = {
  phase: "available",
  scope: "app-only",
  available: {
    app: { version: "0.2.0", sha256: "a".repeat(64) },
    runtime: { version: "0.2.0", sha256: "b".repeat(64) },
    model: { version: "1.0.0", sha256: "c".repeat(64) },
  },
  required: false,
  automaticDiscovery: false,
  problem: null,
};
it("offers explicit Store product actions without custom installers or update polling preferences", () => {
  const execute = vi.fn(async (_command: ConsumerUpdateCommand) => {});
  render(
    <ConsumerUpdatePanel
      view={{
        ...available,
        distribution: "microsoft-store",
        available: null,
        phase: "idle",
      }}
      busy={false}
      execute={execute}
    />,
  );
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Install update" })).toBeNull();
  expect(screen.queryByText("MusicMute is up to date.")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Open MusicMute in Microsoft Store" }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "Open MusicMute Worker in Microsoft Store",
    }),
  );
  expect(execute.mock.calls.map(([command]) => command)).toEqual([
    {
      version: 1,
      request_id: expect.any(String),
      action: "store_open",
      product: "gui",
    },
    {
      version: 1,
      request_id: expect.any(String),
      action: "store_open",
      product: "worker",
    },
  ]);
});
it("localizes the Store update choices in Arabic", () => {
  setLanguage("ar");
  render(
    <ConsumerUpdatePanel
      view={{ ...available, distribution: "microsoft-store" }}
      busy={false}
      execute={vi.fn(async () => {})}
    />,
  );
  expect(
    screen.getByRole("button", {
      name: "فتح عامل MusicMute في Microsoft Store",
    }),
  ).toBeTruthy();
  expect(
    screen.getByText("يدير Microsoft Store تحديثات التطبيق والعامل."),
  ).toBeTruthy();
});
it("lets a cold app request its update without claiming an installed runtime or model and requires explicit install consent", () => {
  const execute = vi.fn(async () => {});
  render(
    <ConsumerUpdatePanel view={available} busy={false} execute={execute} />,
  );
  expect(screen.queryByText("Runtime version")).toBeNull();
  expect(
    screen.getByText(
      "This update installs the app. Local GPU preparation remains a separate step.",
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Install update" }));
  expect(execute).not.toHaveBeenCalled();
  const buttons = screen.getAllByRole("button", { name: "Install update" });
  fireEvent.click(buttons[1]!);
  expect(execute).toHaveBeenCalledWith({
    version: 1,
    request_id: expect.any(String),
    action: "install",
  });
});
it("offers recovery for a retained failed transaction while keeping new installation and discovery fenced", () => {
  const execute = vi.fn(async () => {});
  render(
    <ConsumerUpdatePanel
      view={{
        ...available,
        phase: "blocked",
        problem: "UPDATE_FINALIZE_UNCONFIRMED",
      }}
      maintenance
      busy={false}
      execute={execute}
    />,
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Install update",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Recover update" }));
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({ action: "recover" }),
  );
});
it("reports missing release trust honestly and translates the update controls into Arabic", () => {
  setLanguage("ar");
  render(
    <ConsumerUpdatePanel
      unavailable
      busy={false}
      execute={vi.fn(async () => {})}
    />,
  );
  expect(
    screen.getByRole("heading", { name: "تحديثات MusicMute" }),
  ).toBeTruthy();
  expect(
    screen.getByText("البحث عن التحديثات غير متاح في حزمة التطبيق هذه."),
  ).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "تثبيت التحديث" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it("offers recovery for a prior restart checkpoint without treating the installer as currently running", () => {
  const execute = vi.fn(async () => {});
  render(
    <ConsumerUpdatePanel
      view={{
        ...available,
        phase: "restart-required",
        problem: "UPDATE_RECOVERY_REQUIRED",
      }}
      maintenance
      busy={false}
      execute={execute}
    />,
  );
  const recover = screen.getByRole("button", {
    name: "Recover update",
  }) as HTMLButtonElement;
  expect(recover.disabled).toBe(false);
  fireEvent.click(recover);
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({ action: "recover" }),
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Install update",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
