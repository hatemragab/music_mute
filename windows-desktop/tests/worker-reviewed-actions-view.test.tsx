// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkerAdvancedPanel } from "../src/renderer/worker-advanced-view.js";
import { setLanguage } from "../src/renderer/i18n.js";
import {
  parseFleetAdvancedCommand,
  type FleetAdvancedView,
} from "../src/shared/fleet-advanced-contracts.js";
import type { FleetAdvancedUiCommand } from "../src/shared/contracts.js";

afterEach(() => {
  cleanup();
  setLanguage("en");
});
const machineId = randomUUID();
const view: FleetAdvancedView = {
  phase: "idle",
  machineId,
  section: "status",
  data: null,
  confirmation: null,
  problem: null,
  cancellable: false,
};
function fixture() {
  const execute = vi.fn(async (command: FleetAdvancedUiCommand) => {
    parseFleetAdvancedCommand(command);
  });
  return {
    view,
    machineId,
    busy: false,
    execute,
    exportReport: async () => {},
    selectInput: async () => {},
  };
}

it("uses the fixed Store management route in Advanced while keeping revocation interruption separate", () => {
  const f = fixture();
  render(<WorkerAdvancedPanel {...f} storeManagedUpdates />);
  expect(screen.queryByLabelText("Worker update source")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Install worker update" }),
  ).toBeNull();
  expect(
    screen.getByText("Microsoft Store manages app and worker updates."),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByLabelText("Interrupt accepted jobs for revocation"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Check worker updates" }));
  fireEvent.click(
    screen.getByRole("button", {
      name: "Open MusicMute Worker in Microsoft Store",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Revoke this worker" }));
  expect(f.execute.mock.calls.map(([command]) => command)).toEqual([
    { type: "UPDATE_CHECK" },
    { type: "CONFIRM", mutation: { action: "update" } },
    { type: "CONFIRM", mutation: { action: "revoke", force: true } },
  ]);
});

it("keeps default app updates and revocation nonforced and review-only", () => {
  const f = fixture();
  render(<WorkerAdvancedPanel {...f} />);
  expect(
    (screen.getByLabelText("Worker update source") as HTMLSelectElement).value,
  ).toBe("app");
  expect(
    (
      screen.getByLabelText(
        "Interrupt accepted jobs for updates or revocation",
      ) as HTMLInputElement
    ).checked,
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Check worker updates" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Install worker update" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Revoke this worker" }));
  expect(f.execute.mock.calls.map(([command]) => command)).toEqual([
    { type: "UPDATE_CHECK" },
    { type: "CONFIRM", mutation: { action: "update" } },
    { type: "CONFIRM", mutation: { action: "revoke" } },
  ]);
});

it("routes a deliberately selected catalog and force choice into the closed review commands", () => {
  const f = fixture();
  render(<WorkerAdvancedPanel {...f} />);
  fireEvent.change(screen.getByLabelText("Worker update source"), {
    target: { value: "catalog" },
  });
  fireEvent.click(
    screen.getByLabelText("Interrupt accepted jobs for updates or revocation"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Check worker updates" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Install worker update" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Revoke this worker" }));
  expect(f.execute.mock.calls.map(([command]) => command)).toEqual([
    { type: "UPDATE_CHECK", source: "catalog" },
    {
      type: "CONFIRM",
      mutation: { action: "update", source: "catalog", force: true },
    },
    { type: "CONFIRM", mutation: { action: "revoke", force: true } },
  ]);
});

for (const language of ["en", "ar"] as const)
  it(`reviews explicit Force Stop and Restart without executing either in ${language}`, () => {
    setLanguage(language);
    const f = fixture();
    render(<WorkerAdvancedPanel {...f} />);
    fireEvent.click(
      screen.getByRole("button", {
        name:
          language === "ar"
            ? "إيقاف عامل المعالجة بالقوة"
            : "Force stop worker",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name:
          language === "ar"
            ? "إعادة تشغيل عامل المعالجة بالقوة"
            : "Force restart worker",
      }),
    );
    expect(f.execute.mock.calls.map(([command]) => command)).toEqual([
      { type: "CONFIRM", mutation: { action: "stop", force: true } },
      { type: "CONFIRM", mutation: { action: "restart", force: true } },
    ]);
  });

it("shows the issued force/source review even if the user's draft changes before it arrives", () => {
  const f = fixture(),
    rendered = render(<WorkerAdvancedPanel {...f} />);
  fireEvent.change(screen.getByLabelText("Worker update source"), {
    target: { value: "catalog" },
  });
  fireEvent.click(
    screen.getByLabelText("Interrupt accepted jobs for updates or revocation"),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Install worker update" }),
  );
  fireEvent.change(screen.getByLabelText("Worker update source"), {
    target: { value: "app" },
  });
  fireEvent.click(
    screen.getByLabelText("Interrupt accepted jobs for updates or revocation"),
  );
  const token = randomUUID();
  rendered.rerender(
    <WorkerAdvancedPanel
      {...f}
      view={{
        ...view,
        phase: "confirmation",
        confirmation: {
          token,
          action: "update",
          source: "catalog",
          force: true,
          expiresAt: "2099-01-01T00:00:00Z",
        },
      }}
    />,
  );
  expect(
    screen.getByText(
      "Accepted worker jobs will be interrupted. Protected files and other active work must finish.",
    ),
  ).toBeTruthy();
  expect(screen.getByText("Update source: Signed worker catalog")).toBeTruthy();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Keep current state" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm worker action" }),
  );
  expect(f.execute).toHaveBeenLastCalledWith({
    type: "RUN",
    confirmation: token,
  });
});
