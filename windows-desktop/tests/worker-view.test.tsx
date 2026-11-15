// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkerPanel } from "../src/renderer/worker-view.js";
import { setLanguage } from "../src/renderer/i18n.js";
import type { FleetView } from "../src/shared/fleet-contracts.js";
import type { SessionSnapshot } from "../src/shared/session-contracts.js";
afterEach(() => {
  cleanup();
  setLanguage("en");
});
const fleet: FleetView = {
  state: "registered",
  eligibility: "signed-out",
  busy: false,
  machineId: randomUUID(),
  label: "My worker",
  intent: "running",
  connected: false,
  backendState: null,
  activeAttempts: null,
  claimsAllowed: false,
  errorCode: null,
};
const session: SessionSnapshot = {
  version: 1,
  instance_id: randomUUID(),
  release: "a".repeat(64),
  revision: 1,
  phase: "running",
  fleet: { intent: "running", phase: "running", problem: null },
  personal: { owners: 0, phase: "stopped", problem: null },
  startup: "registered",
  maintenance: null,
};
it("keeps registered worker controls usable without app sign-in", () => {
  const execute = vi.fn(async () => {});
  render(
    <WorkerPanel
      view={fleet}
      session={session}
      busy={false}
      execute={execute}
      signIn={() => {}}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "Open account sign-in" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Pause worker" }));
  expect(execute).toHaveBeenCalledWith({ type: "PAUSE" });
  fireEvent.click(screen.getByRole("button", { name: "Stop worker" }));
  expect(execute).toHaveBeenCalledWith({ type: "STOP" });
});
it("uses the actual session intent instead of stale last command state", () => {
  render(
    <WorkerPanel
      view={fleet}
      session={{
        ...session,
        fleet: { intent: "paused", phase: "paused", problem: null },
      }}
      busy={false}
      execute={async () => {}}
      signIn={() => {}}
    />,
  );
  expect(screen.getByRole("status").textContent).toBe("Worker paused");
  expect(screen.getByRole("button", { name: "Resume worker" })).toBeDefined();
  expect(screen.queryByRole("button", { name: "Pause worker" })).toBeNull();
});
it("does not authorize registration from missing eligibility or lost session", () => {
  const r = render(
    <WorkerPanel
      view={{ ...fleet, state: "absent", eligibility: "approval-required" }}
      busy={false}
      execute={async () => {}}
      signIn={() => {}}
    />,
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Register this PC",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  r.rerender(
    <WorkerPanel
      view={fleet}
      busy={false}
      execute={async () => {}}
      signIn={() => {}}
    />,
  );
  expect(
    (screen.getByRole("button", { name: "Pause worker" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByRole("status").textContent).toBe(
    "Waiting for the worker session…",
  );
});
it("does not expose the old boolean revocation bypass without Advanced", () => {
  const execute = vi.fn(async () => {});
  render(
    <WorkerPanel
      view={fleet}
      session={session}
      busy={false}
      execute={execute}
      signIn={() => {}}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "Revoke this worker" }),
  ).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(execute).not.toHaveBeenCalled();
});

for (const language of ["en", "ar"] as const)
  it(`offers explicit proven invitation renewal instead of repeated restore in ${language}`, () => {
    setLanguage(language);
    const execute = vi.fn(async () => {});
    render(
      <WorkerPanel
        view={{
          ...fleet,
          state: "interrupted",
          eligibility: "ready",
          machineId: null,
          errorCode: "FLEET_INVITATION_EXPIRED",
          renewInvitationAvailable: true,
        }}
        busy={false}
        execute={execute}
        signIn={() => {}}
      />,
    );
    expect(execute).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", {
        name:
          language === "ar"
            ? "تجديد دعوة عامل المعالجة"
            : "Renew worker invitation",
      }),
    );
    expect(execute).toHaveBeenCalledExactlyOnceWith({
      type: "RENEW_INVITATION",
    });
    expect(
      screen.queryByRole("button", { name: "Retry worker setup" }),
    ).toBeNull();
  });

it("keeps regular recovery and fresh eligibility separate from invitation renewal", () => {
  const execute = vi.fn(async () => {}),
    base = {
      view: { ...fleet, state: "interrupted" as const },
      busy: false,
      execute,
      signIn: () => {},
    },
    r = render(<WorkerPanel {...base} />);
  fireEvent.click(screen.getByRole("button", { name: "Retry worker setup" }));
  expect(execute).toHaveBeenCalledWith({ type: "RESTORE" });
  r.rerender(
    <WorkerPanel
      {...base}
      view={{
        ...base.view,
        eligibility: "google-required",
        renewInvitationAvailable: true,
      }}
    />,
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Renew worker invitation",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    screen.getByRole("button", { name: "Open account sign-in" }),
  ).toBeTruthy();
  expect(execute.mock.calls).toHaveLength(1);
});
it("localizes worker status and controls in Arabic", () => {
  setLanguage("ar");
  render(
    <WorkerPanel
      view={fleet}
      session={session}
      busy={false}
      execute={async () => {}}
      signIn={() => {}}
    />,
  );
  expect(screen.getByRole("status").textContent).toBe("العامل يعمل");
  expect(
    screen.getByRole("button", { name: "إيقاف العامل مؤقتًا" }),
  ).toBeDefined();
});
