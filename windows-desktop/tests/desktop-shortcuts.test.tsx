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
import { DEFAULT_PREFERENCES } from "../src/shared/preferences-contracts.js";
import { desktopUiFixture } from "./desktop-ui-fixtures.js";
import { setLanguage } from "../src/renderer/i18n.js";

afterEach(() => {
  cleanup();
  setLanguage("en");
  vi.restoreAllMocks();
});

it("routes Windows keyboard actions through their trusted bridge commands", async () => {
  const f = desktopUiFixture({
    playback: {
      generation: randomUUID(),
      trackId: "local:one",
      phase: "paused",
      variant: "voice",
      position: 4,
      sourcePosition: 4,
      duration: 12,
      url: null,
      requestedPlaying: false,
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
      value: { ...DEFAULT_PREFERENCES, textSize: "large", accent: "mint" },
      resolvedLanguage: "en",
      errorCode: null,
    },
  });
  const reply = async () => ({ ok: true as const, snapshot: f.snapshot() });
  f.bridge.playback = vi.fn(reply);
  f.bridge.prepare = vi.fn(reply);
  f.bridge.preferences = vi.fn(reply);
  f.bridge.library = vi.fn(reply);
  window.musicmute = f.bridge;
  render(<DesktopApp />);
  await screen.findByRole("heading", { name: /Remove the music/ });
  fireEvent.keyDown(window, { key: "ArrowLeft" });
  fireEvent.keyDown(window, { key: "ArrowRight" });
  fireEvent.keyDown(window, { key: "m" });
  fireEvent.keyDown(window, { key: ".", ctrlKey: true });
  await waitFor(() => expect(f.bridge.playback).toHaveBeenCalledTimes(4));
  expect(vi.mocked(f.bridge.playback).mock.calls).toEqual([
    [{ type: "SEEK", seconds: 0 }],
    [{ type: "SEEK", seconds: 12 }],
    [{ type: "MUTE" }],
    [{ type: "STOP" }],
  ]);
  fireEvent.keyDown(window, { key: "r", ctrlKey: true, shiftKey: true });
  await waitFor(() => expect(f.bridge.prepare).toHaveBeenCalledWith("check"));
  await act(async () => {});
  fireEvent.keyDown(window, { key: "0", ctrlKey: true });
  await waitFor(() =>
    expect(f.bridge.preferences).toHaveBeenCalledWith({
      type: "SET",
      patch: { textSize: "system" },
    }),
  );
  expect(f.snapshot().preferences!.value.accent).toBe("mint");
});

it("suppresses repeated, editable, modal and focused-button Space shortcuts", async () => {
  const f = desktopUiFixture({
    section: "settings",
    preferences: {
      state: "ready",
      value: { ...DEFAULT_PREFERENCES },
      resolvedLanguage: "en",
      errorCode: null,
    },
  });
  f.bridge.selectInput = vi.fn(async () => ({
    ok: true as const,
    snapshot: f.snapshot(),
  }));
  f.bridge.playback = vi.fn(async () => ({
    ok: true as const,
    snapshot: f.snapshot(),
  }));
  window.musicmute = f.bridge;
  render(<DesktopApp />);
  const appearance = await screen.findByLabelText("Appearance");
  fireEvent.keyDown(appearance, { key: "n", ctrlKey: true });
  fireEvent.keyDown(window, { key: "n", ctrlKey: true, repeat: true });
  const reset = screen.getByRole("button", { name: "Reset preferences" });
  fireEvent.keyDown(reset, { key: " " });
  fireEvent.click(reset);
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.keyDown(window, { key: "n", ctrlKey: true });
  expect(f.bridge.selectInput).not.toHaveBeenCalled();
  expect(f.bridge.playback).not.toHaveBeenCalled();
});

it("does not open a second picker or navigate while an admitted UI command is pending", async () => {
  const f = desktopUiFixture();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.bridge.selectInput = vi.fn(async () => {
    await waiting;
    return { ok: true as const, snapshot: f.snapshot() };
  });
  window.musicmute = f.bridge;
  render(<DesktopApp />);
  await screen.findByRole("heading", { name: /Remove the music/ });
  fireEvent.keyDown(window, { key: "n", ctrlKey: true });
  await waitFor(() => expect(f.bridge.selectInput).toHaveBeenCalledOnce());
  fireEvent.keyDown(window, { key: "n", ctrlKey: true });
  fireEvent.keyDown(window, { key: "2", ctrlKey: true });
  expect(f.bridge.selectInput).toHaveBeenCalledOnce();
  expect(f.bridge.navigate).not.toHaveBeenCalled();
  await act(async () => {
    release();
    await waiting;
  });
  fireEvent.keyDown(window, { key: "2", ctrlKey: true });
  await waitFor(() =>
    expect(f.bridge.navigate).toHaveBeenCalledWith("library"),
  );
});
