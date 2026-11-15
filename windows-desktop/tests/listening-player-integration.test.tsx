// @vitest-environment jsdom
import { useEffect, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  PlaybackController,
  type PlaybackSource,
} from "../src/main/player/controller.js";
import type {
  BookmarkStore,
  ListeningClock,
} from "../src/main/player/listening.js";
import { PlayerPanel } from "../src/renderer/player-view.js";
import type { PlaybackUiCommand } from "../src/shared/playback-contracts.js";

const players: PlaybackController[] = [];
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(async () => {
  cleanup();
  await Promise.all(players.splice(0).map((player) => player.dispose()));
  vi.restoreAllMocks();
});
function source(): PlaybackSource {
  return {
    url: `http://127.0.0.1:12345/media/00000000-0000-4000-8000-000000000001?capability=${"a".repeat(43)}`,
    originalDuration: 10,
    sourceDuration: 10,
    trimmed: false,
    release: vi.fn(async () => {}),
    analyzeSilence: vi.fn(async () => [{ start: 2, end: 8 }]),
  };
}
function fixture() {
  let seconds = 0;
  const clock: ListeningClock = {
    wall: () => 100000 + seconds * 1000,
    monotonic: () => seconds * 1000,
    set: () => Symbol("sleep"),
    clear: () => {},
  };
  const store: BookmarkStore = {
    read: vi.fn(async () => null),
    write: vi.fn(async () => {}),
    quarantine: vi.fn(async () => {}),
  };
  const sources = { open: vi.fn(async () => source()) },
    accounting = {
      begin: vi.fn(async () => {}),
      pulse: vi.fn(async () => {}),
      end: vi.fn(async () => {}),
    };
  const player = new PlaybackController(sources, accounting, undefined, {
    store,
    clock,
    owner: () => ({ key: "local", fence: "guest" }),
  });
  players.push(player);
  return {
    player,
    store,
    sources,
    advance: (value: number) => {
      seconds += value;
    },
  };
}
function Harness({
  player,
  pending,
}: {
  player: PlaybackController;
  pending: Promise<unknown>[];
}) {
  const [view, setView] = useState(player.view());
  useEffect(() => player.subscribe(setView), [player]);
  const execute = async (command: PlaybackUiCommand) => {
    const operation = player.execute(command);
    pending.push(operation);
    await operation;
  };
  return <PlayerPanel view={view} execute={execute} />;
}
it("sends a visible sleep selection through the actual player while source preparation is pending and keeps the countdown on Ready", async () => {
  const f = fixture(),
    pending: Promise<unknown>[] = [];
  let ready!: (value: PlaybackSource) => void;
  f.sources.open.mockImplementationOnce(
    () =>
      new Promise<PlaybackSource>((resolve) => {
        ready = resolve;
      }),
  );
  const loading = f.player.execute({ type: "LOAD", trackId: "one" });
  await vi.waitFor(() => expect(ready).toBeDefined());
  render(<Harness player={f.player} pending={pending} />);
  fireEvent.click(
    screen.getByRole("button", { name: "More playback controls" }),
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Sleep timer" }), {
    target: { value: "300" },
  });
  await waitFor(() => expect(screen.getByText("5:00 remaining")).toBeTruthy());
  await act(async () => {
    ready(source());
    await loading;
    await Promise.all(pending);
  });
  expect(f.player.view()).toMatchObject({
    phase: "buffering",
    listening: { sleepRemainingSeconds: 300 },
  });
  expect(screen.getByText("5:00 remaining")).toBeTruthy();
});
it("does not save the previous track when a real Bookmark button command waits for preferences and another track wins", async () => {
  const f = fixture(),
    pending: Promise<unknown>[] = [];
  let preferences!: (value: unknown) => void;
  vi.mocked(f.store.read).mockImplementationOnce(
    () =>
      new Promise<unknown>((resolve) => {
        preferences = resolve;
      }),
  );
  await f.player.execute({ type: "LOAD", trackId: "one" });
  render(<Harness player={f.player} pending={pending} />);
  fireEvent.click(
    screen.getByRole("button", { name: "More playback controls" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Bookmark this position" }),
  );
  await act(async () => {
    await f.player.execute({ type: "LOAD", trackId: "two" });
    preferences(null);
    await Promise.all(pending);
  });
  expect(f.store.write).not.toHaveBeenCalled();
  expect(f.player.view()).toMatchObject({
    trackId: "two",
    listening: { bookmarks: [] },
  });
  expect(
    screen.getByText("Save a listening position to return to it later."),
  ).toBeTruthy();
});
it("routes actual AB, skip-silence and sleep UI actions through media events with sleep before AB before silence", async () => {
  const f = fixture(),
    pending: Promise<unknown>[] = [];
  await f.player.execute({ type: "LOAD", trackId: "one" });
  const { container } = render(<Harness player={f.player} pending={pending} />);
  const audio = container.querySelector("audio")!;
  fireEvent.playing(audio);
  await act(async () => {
    await Promise.all(pending);
  });
  fireEvent.click(
    screen.getByRole("button", { name: "More playback controls" }),
  );
  audio.currentTime = 1;
  fireEvent.timeUpdate(audio);
  await act(async () => {
    await Promise.all(pending);
  });
  fireEvent.click(screen.getByRole("button", { name: "Set A" }));
  await act(async () => {
    await Promise.all(pending);
  });
  audio.currentTime = 4;
  fireEvent.timeUpdate(audio);
  await act(async () => {
    await Promise.all(pending);
  });
  fireEvent.click(screen.getByRole("button", { name: "Set B" }));
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "Skip quiet parts during voice playback",
    }),
  );
  await act(async () => {
    await Promise.all(pending);
  });
  expect(f.player.view().listening).toMatchObject({
    loopStart: 1,
    loopEnd: 4,
    skipSilence: true,
  });
  audio.currentTime = 4.1;
  fireEvent.timeUpdate(audio);
  await act(async () => {
    await Promise.all(pending);
  });
  expect(f.player.view().sourcePosition).toBe(1);
  const revision = f.player.view().seekRevision;
  await act(async () => {
    await f.player.execute({ type: "SLEEP", seconds: 1 });
  });
  f.advance(2);
  audio.currentTime = 4.2;
  fireEvent.timeUpdate(audio);
  await act(async () => {
    await Promise.all(pending);
  });
  expect(f.player.view()).toMatchObject({
    requestedPlaying: false,
    phase: "paused",
    seekRevision: revision,
    listening: { sleepRemainingSeconds: null },
  });
});
