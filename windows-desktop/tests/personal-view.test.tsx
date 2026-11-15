// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { PersonalPanel } from "../src/renderer/personal-view.js";
import { setLanguage } from "../src/renderer/i18n.js";
import type {
  PersonalJobView,
  PersonalWaitReason,
} from "../src/shared/personal-contracts.js";
afterEach(() => {
  cleanup();
  setLanguage("en");
});
it("requires fresh rights confirmation after selecting a different file", async () => {
  const props = {
    view: { connected: true, busy: false, jobs: [], error: null },
    prepared: true,
    busy: false,
    execute: vi.fn(async () => {}),
  };
  const { rerender } = render(
    <PersonalPanel
      {...props}
      selected={{ capability: randomUUID(), name: "first.wav", bytes: 12 }}
    />,
  );
  const button = screen.getByRole("button", {
    name: "Process locally",
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/I have permission/));
  expect(button.disabled).toBe(false);
  rerender(
    <PersonalPanel
      {...props}
      selected={{ capability: randomUUID(), name: "second.wav", bytes: 12 }}
    />,
  );
  await waitFor(() => expect(button.disabled).toBe(true));
});
it("shows actual progress and sends the exact owned cancel command", () => {
  const id = randomUUID(),
    execute = vi.fn(async () => {});
  render(
    <PersonalPanel
      prepared
      busy={false}
      execute={execute}
      view={{
        connected: true,
        busy: true,
        error: null,
        jobs: [
          {
            id,
            ownerId: randomUUID(),
            name: "sample.wav",
            state: "preparing",
            stage: "separation",
            progress: 0.41,
            error: null,
            original: null,
            vocals: null,
          },
        ],
      }}
    />,
  );
  expect(screen.getByRole("progressbar").getAttribute("value")).toBe("41");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(execute).toHaveBeenCalledWith({ type: "CANCEL", jobId: id });
});
it("retains a recoverable connection error without a perpetual connecting status", () => {
  render(
    <PersonalPanel
      prepared
      busy={false}
      execute={async () => {}}
      view={{
        connected: false,
        busy: false,
        jobs: [],
        error: "PREPARE_REQUIRED",
      }}
    />,
  );
  expect(screen.getByRole("alert").textContent).toMatch(/Open Prepare/);
  expect(screen.queryByText(/Connecting/)).toBeNull();
});
it("translates the active processing stage and its accessible progress name while retaining exact cancellation ownership", () => {
  const id = randomUUID(),
    execute = vi.fn(async () => {}),
    props = {
      prepared: true,
      busy: false,
      execute,
      view: {
        connected: true,
        busy: true,
        error: null,
        jobs: [
          {
            id,
            ownerId: randomUUID(),
            name: "مقطع sample.wav",
            state: "preparing" as const,
            stage: "model-load" as const,
            progress: 0.12,
            error: null,
            original: null,
            vocals: null,
          },
        ],
      },
    };
  const { rerender } = render(<PersonalPanel {...props} />);
  expect(screen.getByText("Loading the voice model")).toBeTruthy();
  setLanguage("ar");
  rerender(<PersonalPanel {...props} />);
  expect(screen.getByText("جارٍ تحميل نموذج الصوت")).toBeTruthy();
  expect(
    screen.getByRole("progressbar", { name: "تقدّم معالجة مقطع sample.wav" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "إلغاء" }));
  expect(execute).toHaveBeenCalledWith({ type: "CANCEL", jobId: id });
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
  "shows current %s admission state without an invented percent and clears stale waiting at model load/Ready",
  (waitReason: PersonalWaitReason, english, arabic) => {
    const job: PersonalJobView = {
      id: randomUUID(),
      ownerId: randomUUID(),
      name: "مقطع sample.wav",
      state: "preparing",
      stage: "preparation",
      waitReason,
      progress: 0.4,
      error: null,
      original: null,
      vocals: null,
    };
    const execute = vi.fn(async () => {});
    const props = {
      prepared: true,
      busy: false,
      execute,
      view: { connected: true, busy: true, error: null, jobs: [job] },
    };
    const { container, rerender } = render(<PersonalPanel {...props} />);
    expect(screen.getByText(english)).toBeTruthy();
    expect(screen.getByRole("progressbar").hasAttribute("value")).toBe(false);
    expect(container.querySelector("audio")).toBeNull();
    setLanguage("ar");
    rerender(<PersonalPanel {...props} />);
    expect(screen.getByText(arabic)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "إلغاء" }));
    expect(execute).toHaveBeenCalledWith({ type: "CANCEL", jobId: job.id });
    setLanguage("en");
    rerender(
      <PersonalPanel
        {...props}
        view={{ ...props.view, jobs: [{ ...job, stage: "model-load" }] }}
      />,
    );
    expect(screen.queryByText(english)).toBeNull();
    expect(screen.getByText("Loading the voice model")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("40");
    rerender(
      <PersonalPanel
        {...props}
        view={{ ...props.view, jobs: [{ ...job, state: "ready" }] }}
      />,
    );
    expect(screen.queryByText(english)).toBeNull();
    expect(screen.getByText("Voice ready — available in Library")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  },
);

it("a terminal GPU-busy refusal asks for a new try instead of promising that failed work will resume", () => {
  render(
    <PersonalPanel
      prepared
      busy={false}
      execute={async () => {}}
      view={{
        connected: true,
        busy: false,
        error: null,
        jobs: [
          {
            id: randomUUID(),
            ownerId: randomUUID(),
            name: "sample.wav",
            state: "failed",
            stage: "preparation",
            waitReason: "gpu-busy",
            progress: null,
            error: "GPU_BUSY",
            original: null,
            vocals: null,
          },
        ],
      }}
    />,
  );
  expect(
    screen.getByText(
      "The GPU is busy. Wait for current work to finish, then try again.",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
});
