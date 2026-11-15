// @vitest-environment jsdom
// Actual controller/intents/React composition; private worker/copy and IPC are injected.
import { randomUUID } from "node:crypto";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  DesktopPersonalController,
  type DesktopPersonalPort,
} from "../src/main/desktop-personal.js";
import { PersonalPlaybackIntents } from "../src/main/personal/playback-intents.js";
import { DesktopApp } from "../src/renderer/app.js";
import { setLanguage } from "../src/renderer/i18n.js";
import { desktopUiFixture } from "./desktop-ui-fixtures.js";

afterEach(() => {
  cleanup();
  setLanguage("en");
});
it("presents the actual fresh intake before copying, cancels the exact request, and waits for cleanup without creating audio/history", async () => {
  const capability = randomUUID(),
    f = desktopUiFixture({
      setup: { state: "ready", message: "Local GPU processing is ready." },
      personal: { connected: true, busy: false, jobs: [], error: null },
      selectedInput: { capability, name: "recording.wav", bytes: 1024 },
    });
  let finishCopy!: () => void,
    copyingSignal: AbortSignal | undefined,
    controller!: DesktopPersonalController;
  const gate = new PersonalPlaybackIntents({
    installationId: randomUUID(),
    context: () => ({ windowCurrent: true, scope: null, playbackEpoch: 0 }),
    job: (id) => controller.view().jobs.find((job) => job.id === id),
  });
  const port: DesktopPersonalPort = {
    scope: () => null,
    stage: vi.fn(async (_cap, _window, _owner, _scope, signal) => {
      copyingSignal = signal;
      await new Promise<void>((resolve) => {
        finishCopy = resolve;
      });
      signal.throwIfAborted();
      return capability;
    }),
    command: vi.fn(async (command) => ({
      version: 1 as const,
      requestId: command.requestId,
      ok: true,
      jobs: [],
    })),
    watch: vi.fn(async () => {}),
  };
  controller = new DesktopPersonalController(port, {
    created: (intent) => gate.created(intent),
    accepted: (intent, job) => gate.accepted(intent.requestId, job),
    retired: (intent) => gate.retire(intent.requestId),
    cancelled: (_owner, jobId) => gate.cancelJob(jobId),
    disposed: (owner) => gate.retireOwner(owner),
  });
  controller.connected();
  const detachPersonal = controller.subscribe((personal) =>
      f.publish({ personal }),
    ),
    detachPreparation = gate.subscribe((pendingPlayback) =>
      f.publish({ pendingPlayback }),
    );
  f.bridge.personal = vi.fn(async (command) => {
    await controller.execute(command, "fixture-window");
    return { ok: true as const, snapshot: f.snapshot() };
  });
  window.musicmute = f.bridge;
  const { container } = render(<DesktopApp />);
  await screen.findByText("Selected: recording.wav");
  fireEvent.click(
    screen.getByLabelText(
      "I have permission to download and process this audio.",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Process locally" }));
  const cancel = await screen.findByRole("button", {
    name: "Cancel pending playback",
  });
  const preparation = gate.view()!;
  expect(preparation).toEqual({ requestId: expect.any(String), jobId: null });
  expect(container.querySelector("audio")).toBeNull();
  expect(port.command).not.toHaveBeenCalled();
  fireEvent.click(cancel);
  await waitFor(() => expect(copyingSignal?.aborted).toBe(true));
  expect(f.bridge.personal).toHaveBeenLastCalledWith({
    type: "CANCEL_REQUEST",
    requestId: preparation.requestId,
  });
  expect(gate.view()).toBeNull();
  expect(controller.view().busy).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Library" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await act(async () => {
    finishCopy();
  });
  await waitFor(() => expect(controller.view().busy).toBe(false));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Library" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  expect(controller.view().jobs).toEqual([]);
  expect(port.command).not.toHaveBeenCalled();
  detachPersonal();
  detachPreparation();
  await controller.dispose();
});
