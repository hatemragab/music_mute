// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkerAdvancedPanel } from "../src/renderer/worker-advanced-view.js";
import type { FleetAdvancedView } from "../src/shared/fleet-advanced-contracts.js";
import { setLanguage } from "../src/renderer/i18n.js";
afterEach(() => {
  cleanup();
  setLanguage("en");
});
const machineId = randomUUID(),
  token = randomUUID();
const view: FleetAdvancedView = {
  phase: "idle",
  machineId,
  section: "status",
  data: { running: false },
  confirmation: null,
  problem: null,
  cancellable: false,
};
const defaults = {
  view,
  machineId,
  busy: false,
  execute: async () => {},
  exportReport: async () => {},
  selectInput: async () => {},
};
it("requests one-use confirmation before any destructive operation", () => {
  const execute = vi.fn(async () => {});
  render(<WorkerAdvancedPanel {...defaults} execute={execute} />);
  fireEvent.click(screen.getByRole("button", { name: "Revoke this worker" }));
  expect(execute).toHaveBeenCalledWith({
    type: "CONFIRM",
    mutation: { action: "revoke" },
  });
  expect(execute.mock.calls).toHaveLength(1);
});
it("does not permit a stale machine confirmation to run", () => {
  const execute = vi.fn(async () => {}),
    confirmed = {
      ...view,
      phase: "confirmation" as const,
      confirmation: {
        token,
        action: "revoke" as const,
        expiresAt: "2099-01-01T00:00:00Z",
      },
    };
  const r = render(
    <WorkerAdvancedPanel {...defaults} view={confirmed} execute={execute} />,
  );
  expect(
    screen.getByRole("dialog", { name: "Confirm worker action" }),
  ).toBeDefined();
  r.rerender(
    <WorkerAdvancedPanel
      {...defaults}
      view={confirmed}
      machineId={randomUUID()}
      execute={execute}
    />,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(execute).not.toHaveBeenCalled();
});
it("sends the issued token only after explicit confirmation", () => {
  const execute = vi.fn(async () => {});
  render(
    <WorkerAdvancedPanel
      {...defaults}
      view={{
        ...view,
        phase: "confirmation",
        confirmation: {
          token,
          action: "cleanup",
          expiresAt: "2099-01-01T00:00:00Z",
        },
      }}
      execute={execute}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm worker action" }),
  );
  expect(execute).toHaveBeenCalledWith({ type: "RUN", confirmation: token });
});
it("enforces relevant filters and keeps hidden invalid draft fields from blocking another report", () => {
  const execute = vi.fn(async () => {});
  render(<WorkerAdvancedPanel {...defaults} execute={execute} />);
  fireEvent.change(screen.getByLabelText("Report"), {
    target: { value: "job" },
  });
  expect(
    (screen.getByRole("button", { name: "Read report" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("Job ID"), {
    target: { value: "invalid" },
  });
  fireEvent.change(screen.getByLabelText("Report"), {
    target: { value: "capacity" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Read report" }));
  expect(execute).toHaveBeenCalledWith({
    type: "READ",
    section: "capacity",
    filter: {},
  });
});
it("can cancel an active action even while the outer command is awaiting its reply", () => {
  const execute = vi.fn(async () => {});
  render(
    <WorkerAdvancedPanel
      {...defaults}
      busy
      view={{ ...view, phase: "running", cancellable: true }}
      execute={execute}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel worker action" }));
  expect(execute).toHaveBeenCalledWith({ type: "CANCEL" });
});
it("clears benchmark rights on input replacement and never submits a raw filename", () => {
  const execute = vi.fn(async () => {}),
    capability = randomUUID();
  const r = render(
    <WorkerAdvancedPanel
      {...defaults}
      execute={execute}
      selectedInput={{ capability, name: "fixture.mp3" }}
    />,
  );
  fireEvent.click(
    screen.getByLabelText("I have permission to process this audio."),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Prepare benchmark confirmation" }),
  );
  expect(execute).toHaveBeenCalledWith({
    type: "CONFIRM",
    mutation: {
      action: "benchmark_file",
      groupSize: 1,
      inputCapability: capability,
      recipe: "kim-vocals-v2",
      warmupRuns: 1,
      measuredRuns: 3,
      rightsConfirmed: true,
    },
  });
  r.rerender(
    <WorkerAdvancedPanel
      {...defaults}
      execute={execute}
      selectedInput={{ capability: randomUUID(), name: "other.mp3" }}
    />,
  );
  expect(
    (
      screen.getByLabelText(
        "I have permission to process this audio.",
      ) as HTMLInputElement
    ).checked,
  ).toBe(false);
});
it("requires trusted destination choices before preparing a baseline/candidate/saved-audio benchmark", () => {
  const execute = vi.fn(async () => {}),
    pickBenchmark = vi.fn(async () => {}),
    input = { capability: randomUUID(), name: "fixture.wav" },
    baseline = { capability: randomUUID(), name: "baseline.json", bytes: 100 },
    audioDestination = randomUUID(),
    reportDestination = randomUUID();
  const r = render(
    <WorkerAdvancedPanel
      {...defaults}
      execute={execute}
      selectedInput={input}
      pickBenchmark={pickBenchmark}
    />,
  );
  fireEvent.click(
    screen.getByLabelText("I have permission to process this audio."),
  );
  fireEvent.click(screen.getByLabelText("Compare with a saved baseline"));
  fireEvent.click(screen.getByLabelText("Save benchmark audio"));
  fireEvent.click(screen.getByLabelText("Save benchmark report"));
  expect(
    (
      screen.getByRole("button", {
        name: "Prepare benchmark confirmation",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: "Choose audio destination" }),
  );
  expect(pickBenchmark).toHaveBeenCalledWith("audio");
  fireEvent.change(screen.getByLabelText("Candidate runtime release"), {
    target: { value: "a".repeat(64) },
  });
  r.rerender(
    <WorkerAdvancedPanel
      {...defaults}
      execute={execute}
      selectedInput={input}
      pickBenchmark={pickBenchmark}
      benchmark={{ baseline, audioDestination, reportDestination }}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Prepare benchmark confirmation" }),
  );
  expect(execute).toHaveBeenCalledWith({
    type: "CONFIRM",
    mutation: {
      action: "benchmark_file",
      inputCapability: input.capability,
      recipe: "kim-vocals-v2",
      groupSize: 1,
      warmupRuns: 1,
      measuredRuns: 3,
      rightsConfirmed: true,
      candidateRelease: "a".repeat(64),
      baselineCapability: baseline.capability,
      saveAudio: true,
      audioDestinationCapability: audioDestination,
      reportDestinationCapability: reportDestination,
    },
  });
});
it("follows local log events with a bounded validated filter", () => {
  const execute = vi.fn(async () => {});
  render(<WorkerAdvancedPanel {...defaults} execute={execute} />);
  fireEvent.change(screen.getByLabelText("Report"), {
    target: { value: "logs" },
  });
  fireEvent.click(screen.getByLabelText("Follow local logs"));
  expect(execute).toHaveBeenCalledWith({
    type: "READ",
    section: "logs",
    filter: { lines: 100, errorsOnly: false, follow: true },
  });
});
