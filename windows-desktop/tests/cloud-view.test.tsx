// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CloudPanel, ProcessingChoice } from "../src/renderer/cloud-view.js";
import type { CloudView } from "../src/shared/cloud-contracts.js";
afterEach(cleanup);
const view = (patch: Partial<CloudView> = {}): CloudView => ({
  mode: "cloud",
  ready: true,
  reason: null,
  signInRequired: false,
  linkImportVisible: true,
  connection: "live",
  busy: false,
  phase: "idle",
  confirmation: null,
  job: null,
  errorCode: null,
  resultCapability: null,
  ...patch,
});
it("requires rights for an exact frozen confirmation and resets them when confirmation changes", () => {
  const execute = vi.fn(async () => {}),
    c = {
      capability: "one",
      requestId: "request",
      kind: "file" as const,
      title: "audio.wav",
      estimatedDurationSeconds: null,
      expiresAt: "2026-10-10T00:00:00Z",
    };
  const rendered = render(
    <CloudPanel
      view={view({ confirmation: c, phase: "confirming" })}
      busy={false}
      execute={execute}
      openLibrary={() => {}}
    />,
  );
  const confirm = screen.getByRole("button", {
    name: "Confirm cloud processing",
  });
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(confirm);
  expect(execute).toHaveBeenCalledWith({
    type: "CONFIRM",
    capability: "one",
    rightsConfirmed: true,
  });
  rendered.rerender(
    <CloudPanel
      view={view({
        confirmation: { ...c, capability: "two" },
        phase: "confirming",
      })}
      busy={false}
      execute={execute}
      openLibrary={() => {}}
    />,
  );
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(
    false,
  );
});
it("reviews a supported link without starting processing and rejects a foreign URL", () => {
  const execute = vi.fn(async () => {});
  render(
    <CloudPanel
      view={view()}
      busy={false}
      execute={execute}
      openLibrary={() => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText("YouTube video link"), {
    target: { value: "https://evil.example/watch?v=bZxrIoCPsOc" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review link" }));
  expect(execute).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("YouTube video link"), {
    target: { value: "https://www.youtube.com/watch?v=bZxrIoCPsOc" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review link" }));
  expect(execute).toHaveBeenCalledWith({
    type: "PREPARE_YOUTUBE",
    videoId: "bZxrIoCPsOc",
  });
});
it("keeps a signed-out cloud choice visible and lets the user explicitly choose local", () => {
  const execute = vi.fn(async () => {});
  render(
    <ProcessingChoice
      view={view({
        ready: false,
        signInRequired: true,
        reason: "SIGN_IN_REQUIRED",
      })}
      busy={false}
      execute={execute}
    />,
  );
  expect(
    (screen.getByRole("radio", { name: "MusicMute cloud" }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "This PC · GPU" }));
  expect(execute).toHaveBeenCalledWith({ type: "SET_MODE", mode: "local" });
});
