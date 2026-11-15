// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DiagnosticsPanel } from "../src/renderer/diagnostics-view.js";
import { diagnosticReport } from "../src/main/diagnostics/projection.js";
import { diagnosticIdentity } from "./diagnostics-fixtures.js";
import { setLanguage } from "../src/renderer/i18n.js";
import type { WindowsDiagnosticsView } from "../src/shared/diagnostics-contracts.js";
afterEach(() => {
  cleanup();
  setLanguage("en");
});
function fixture(patch: Partial<WindowsDiagnosticsView> = {}) {
  return {
    view: {
      busy: false,
      problem: null,
      exportReceipt: null,
      doctor: null,
      report: diagnosticReport({
        events: [],
        identity: diagnosticIdentity,
        now: 1700000000000,
        availability: "no-logs",
        failureCode: null,
        malformed: 0,
        recovered: 0,
        rejected: 0,
        failedWrites: 0,
        retained: 0,
        maximum: 1048576,
        incomplete: false,
      }),
      ...patch,
    },
    busy: false,
    execute: vi.fn(async () => {}),
    exportReport: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  };
}
it("uses narrow inspect/CPU doctor/export commands and requires explicit local-log clear consent", () => {
  const f = fixture();
  render(<DiagnosticsPanel {...f} />);
  fireEvent.click(screen.getByRole("button", { name: "Check local tools" }));
  expect(f.execute).toHaveBeenCalledWith({ type: "DOCTOR" });
  fireEvent.click(
    screen.getByRole("button", { name: "Export local diagnostics" }),
  );
  expect(f.exportReport).toHaveBeenCalledOnce();
  expect(
    (
      screen.getByRole("button", {
        name: "Show saved report",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: "Clear local diagnostics" }),
  );
  expect(f.clear).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getAllByRole("button", { name: "Clear local diagnostics" })[1]!,
  );
  expect(f.clear).toHaveBeenCalledOnce();
});
it("shows partial observations honestly and keeps cancellation available while the doctor is busy", () => {
  const f = fixture({ busy: true });
  f.view.report!.coverage.incompleteHistory = true;
  render(<DiagnosticsPanel {...f} />);
  expect(
    screen.getByText(
      "This report contains partial history. Missing observations are marked unavailable.",
    ),
  ).toBeTruthy();
  expect(
    (
      screen.getByRole("button", {
        name: "Check local tools",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: "Cancel diagnostic action" }),
  );
  expect(f.execute).toHaveBeenCalledWith({ type: "CANCEL" });
});
it("translates diagnostics controls and reports unavailable local tooling without exposing native paths", () => {
  setLanguage("ar");
  const f = fixture();
  render(<DiagnosticsPanel {...f} unavailable />);
  expect(screen.getByRole("heading", { name: "التشخيص المحلي" })).toBeTruthy();
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(
    (
      screen.getByRole("button", {
        name: "فحص الأدوات المحلية",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
