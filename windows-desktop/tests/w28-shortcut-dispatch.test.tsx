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
import { DesktopApp } from "../src/renderer/app.js";
import { DEFAULT_PREFERENCES } from "../src/shared/preferences-contracts.js";
import { desktopUiFixture } from "./desktop-ui-fixtures.js";
import { setLanguage } from "../src/renderer/i18n.js";
afterEach(() => {
  cleanup();
  setLanguage("en");
});
function fixture(
  requestedPlaying = false,
  section: "home" | "settings" = "home",
) {
  const f = desktopUiFixture({
    section,
    playback: {
      generation: randomUUID(),
      trackId: "local:one",
      phase: "paused",
      variant: "voice",
      position: 4,
      sourcePosition: 4,
      duration: 12,
      url: null,
      requestedPlaying,
      seekRevision: 0,
      rate: 1,
      volume: 0.8,
      muted: false,
      repeat: "off",
      shuffle: false,
      queue: [],
      queueRevision: 0,
      error: null,
    },
    preferences: {
      state: "ready",
      value: { ...DEFAULT_PREFERENCES, textSize: "standard", accent: "mint" },
      resolvedLanguage: "en",
      errorCode: null,
    },
  });
  const reply = async () => ({ ok: true as const, snapshot: f.snapshot() });
  f.bridge.playback = vi.fn(reply);
  f.bridge.library = vi.fn(reply);
  f.bridge.preferences = vi.fn(reply);
  window.musicmute = f.bridge;
  return f;
}
it.each([
  { key: "1", section: "home" },
  { key: "3", section: "account" },
  { key: "4", section: "setup" },
  { key: "5", section: "diagnostics" },
] as const)(
  "dispatches named route Ctrl+$key through the real App keyboard handler",
  async ({ key, section }) => {
    const f = fixture(false, "settings");
    render(<DesktopApp />);
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    fireEvent.keyDown(window, { key, ctrlKey: true });
    await waitFor(() =>
      expect(f.bridge.navigate).toHaveBeenCalledWith(section),
    );
    expect(document.activeElement?.tagName).toBe("H1");
  },
);
it.each([
  { key: "p", ctrlKey: true, shiftKey: true, command: { type: "PLAY" } },
  { key: " ", ctrlKey: false, shiftKey: false, command: { type: "PLAY" } },
  {
    key: "v",
    ctrlKey: true,
    shiftKey: true,
    command: { type: "SOURCE", variant: "original" },
  },
  { key: "ArrowRight", ctrlKey: true, altKey: true, command: { type: "NEXT" } },
  {
    key: "ArrowUp",
    ctrlKey: true,
    altKey: true,
    command: { type: "VOLUME", level: expect.closeTo(0.85, 10) },
  },
  {
    key: "ArrowDown",
    ctrlKey: true,
    altKey: true,
    command: { type: "VOLUME", level: 0.75 },
  },
] as const)(
  "dispatches the remaining player chord $key to its trusted bridge action",
  async ({ command, ...event }) => {
    const f = fixture();
    render(<DesktopApp />);
    await screen.findByRole("heading", { level: 1, name: "Home" });
    fireEvent.keyDown(window, event);
    await waitFor(() =>
      expect(f.bridge.playback).toHaveBeenCalledWith(command),
    );
  },
);
it("uses the current playing state for pause and sends star without inventing another preference store", async () => {
  const f = fixture(true);
  render(<DesktopApp />);
  await screen.findByRole("heading", { level: 1, name: "Home" });
  fireEvent.keyDown(window, { key: "p", ctrlKey: true, shiftKey: true });
  await waitFor(() =>
    expect(f.bridge.playback).toHaveBeenCalledWith({ type: "PAUSE" }),
  );
  fireEvent.keyDown(window, { key: "f", ctrlKey: true, shiftKey: true });
  await waitFor(() =>
    expect(f.bridge.library).toHaveBeenCalledWith({
      type: "STAR",
      trackId: "local:one",
    }),
  );
});
it.each([
  { key: "+", shiftKey: true, textSize: "large" },
  { key: "-", shiftKey: false, textSize: "small" },
] as const)(
  "changes text $key while preserving all other preferences",
  async ({ key, shiftKey, textSize }) => {
    const f = fixture();
    render(<DesktopApp />);
    await screen.findByRole("heading", { level: 1, name: "Home" });
    fireEvent.keyDown(window, { key, ctrlKey: true, shiftKey });
    await waitFor(() =>
      expect(f.bridge.preferences).toHaveBeenCalledWith({
        type: "SET",
        patch: { textSize },
      }),
    );
    expect(f.snapshot().preferences!.value.accent).toBe("mint");
  },
);
