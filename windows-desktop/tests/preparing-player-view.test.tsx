// @vitest-environment jsdom
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
import { DesktopApp } from "../src/renderer/app.js";
import { PreparingPlayerPanel } from "../src/renderer/preparing-player-view.js";
import type { PersonalJobView } from "../src/shared/personal-contracts.js";
import { desktopUiFixture } from "./desktop-ui-fixtures.js";
import { setLanguage } from "../src/renderer/i18n.js";

afterEach(() => {
  cleanup();
  setLanguage("en");
});
it("shows preparing progress without audio or playback controls before verified media exists", async () => {
  const job: PersonalJobView = {
      id: randomUUID(),
      ownerId: randomUUID(),
      state: "preparing",
      stage: "separation",
      progress: 0.25,
      name: "Mixed عربي title.wav",
      error: null,
      original: null,
      vocals: null,
    },
    cancel = vi.fn(async () => {});
  const { container, rerender } = render(
    <PreparingPlayerPanel job={job} cancel={cancel} />,
  );
  expect(screen.getByRole("status").textContent).toBe("Preparing playback…");
  expect(screen.getByRole("progressbar").getAttribute("value")).toBe("25");
  expect(container.querySelector("audio")).toBeNull();
  expect(screen.queryByRole("button", { name: "Play playback" })).toBeNull();
  expect(container.querySelector("bdi")!.textContent).toBe(job.name);
  setLanguage("ar");
  rerender(<PreparingPlayerPanel job={job} cancel={cancel} />);
  expect(screen.getByRole("status").textContent).toBe("جارٍ تجهيز التشغيل…");
  fireEvent.click(
    screen.getByRole("button", { name: "إلغاء التشغيل قيد التجهيز" }),
  );
  await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  rerender(
    <PreparingPlayerPanel job={{ ...job, state: "failed" }} cancel={cancel} />,
  );
  expect(screen.queryByRole("region")).toBeNull();
});

it("can cancel staging while keeping UI busy until the original accepted command actually settles", async () => {
  const requestId = randomUUID(),
    capability = randomUUID(),
    f = desktopUiFixture({
      setup: { state: "ready", message: "Local GPU processing is ready." },
      personal: { connected: true, busy: false, jobs: [], error: null },
      selectedInput: { capability, name: "recording.wav", bytes: 1024 },
    });
  let finish!: () => void;
  const submitted = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.bridge.personal = vi.fn(async (command) => {
    if (command.type === "SUBMIT_FILE") {
      f.publish({ pendingPlayback: { requestId, jobId: null } });
      await submitted;
    } else if (command.type === "CANCEL_REQUEST")
      f.publish({ pendingPlayback: null });
    return { ok: true as const, snapshot: f.snapshot() };
  });
  window.musicmute = f.bridge;
  const { container } = render(<DesktopApp />);
  await screen.findByText("Selected: recording.wav");
  await act(async () => {});
  fireEvent.click(
    screen.getByLabelText(
      "I have permission to download and process this audio.",
    ),
  );
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Process locally",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Process locally" }));
  const cancel = await screen.findByRole("button", {
    name: "Cancel pending playback",
  });
  expect((cancel as HTMLButtonElement).disabled).toBe(false);
  expect(container.querySelector("audio")).toBeNull();
  fireEvent.click(cancel);
  await waitFor(() =>
    expect(f.bridge.personal).toHaveBeenCalledWith({
      type: "CANCEL_REQUEST",
      requestId,
    }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "Preparing playback" }),
    ).toBeNull(),
  );
  expect(
    (screen.getByRole("button", { name: "Library" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await act(async () => {
    finish();
    await submitted;
  });
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Library" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
});

it("routes an acknowledged pending job cancel to that exact owned job ID", async () => {
  const jobId = randomUUID(),
    f = desktopUiFixture({
      pendingPlayback: { requestId: randomUUID(), jobId },
    });
  f.bridge.personal = vi.fn(async () => ({
    ok: true as const,
    snapshot: f.snapshot(),
  }));
  window.musicmute = f.bridge;
  render(<DesktopApp />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Cancel pending playback" }),
  );
  await waitFor(() =>
    expect(f.bridge.personal).toHaveBeenCalledWith({ type: "CANCEL", jobId }),
  );
});

it.each([
  ["waiting-for-worker", "Waiting for worker", "بانتظار العامل"],
  ["gpu-busy", "The GPU is busy", "معالج الرسومات مشغول"],
  [
    "recovering",
    "Recovering local processing",
    "جارٍ استعادة المعالجة المحلية",
  ],
] as const)(
  "projects %s in pending playback without audio/percent and preserves cancellation",
  async (waitReason, english, arabic) => {
    const job: PersonalJobView = {
      id: randomUUID(),
      ownerId: randomUUID(),
      name: "Mixed عربي title.wav",
      state: "preparing",
      stage: "preparation",
      waitReason,
      progress: 0.4,
      error: null,
      original: null,
      vocals: null,
    };
    const cancel = vi.fn(async () => {});
    const { container, rerender } = render(
      <PreparingPlayerPanel job={job} cancel={cancel} />,
    );
    expect(screen.getByRole("status").textContent).toBe(english);
    expect(screen.getByRole("progressbar").hasAttribute("value")).toBe(false);
    expect(container.querySelector("audio")).toBeNull();
    expect(screen.queryByRole("button", { name: "Play playback" })).toBeNull();
    setLanguage("ar");
    rerender(<PreparingPlayerPanel job={job} cancel={cancel} />);
    expect(screen.getByRole("status").textContent).toBe(arabic);
    fireEvent.click(
      screen.getByRole("button", { name: "إلغاء التشغيل قيد التجهيز" }),
    );
    await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    setLanguage("en");
    rerender(
      <PreparingPlayerPanel
        job={{ ...job, stage: "model-load" }}
        cancel={cancel}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("Preparing playback…");
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("40");
    rerender(
      <PreparingPlayerPanel
        job={{ ...job, state: "cancelled" }}
        cancel={cancel}
      />,
    );
    expect(screen.queryByRole("region")).toBeNull();
  },
);
