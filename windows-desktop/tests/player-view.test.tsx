// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { PlayerPanel } from "../src/renderer/player-view.js";
import type { PlaybackView } from "../src/shared/playback-contracts.js";
import { setLanguage } from "../src/renderer/i18n.js";
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setLanguage("en");
});
function view(patch: Partial<PlaybackView> = {}): PlaybackView {
  return {
    generation: randomUUID(),
    trackId: "local:one",
    phase: "paused",
    variant: "voice",
    position: 12,
    sourcePosition: 4,
    duration: 80,
    url: "http://127.0.0.1:1234/media/one?capability=x",
    requestedPlaying: false,
    seekRevision: 1,
    rate: 1,
    volume: 0.8,
    muted: false,
    repeat: "off",
    shuffle: false,
    queue: [],
    queueRevision: 0,
    error: null,
    ...patch,
  };
}
it("presents preparing controls immediately without an audio URL", () => {
  render(
    <PlayerPanel
      view={view({ phase: "preparing", url: null })}
      execute={async () => {}}
    />,
  );
  expect(screen.getByRole("status").textContent).toBe("Preparing playback…");
  expect(
    (screen.getByRole("button", { name: "Play playback" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it("sends logical seek, original comparison, rate and percentage volume", () => {
  const execute = vi.fn(async () => {});
  render(<PlayerPanel view={view()} execute={execute} />);
  fireEvent.change(screen.getByRole("slider", { name: /Position/ }), {
    target: { value: "30" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Compare original" }));
  fireEvent.click(
    screen.getByRole("button", { name: "More playback controls" }),
  );
  fireEvent.change(screen.getByLabelText("Playback speed"), {
    target: { value: "1.5" },
  });
  fireEvent.change(screen.getByLabelText("Playback volume"), {
    target: { value: "35" },
  });
  expect(execute.mock.calls).toEqual([
    [{ type: "SEEK", seconds: 30 }],
    [{ type: "SOURCE", variant: "original" }],
    [{ type: "RATE", rate: 1.5 }],
    [{ type: "VOLUME", level: 0.35 }],
  ]);
});
it("binds media events to their element generation and mapped source position", async () => {
  const execute = vi.fn(async () => {}),
    snapshot = view({ requestedPlaying: true });
  const { container } = render(
    <PlayerPanel view={snapshot} execute={execute} />,
  );
  const audio = container.querySelector("audio")!;
  fireEvent.loadedMetadata(audio);
  expect(audio.currentTime).toBe(4);
  audio.currentTime = 5;
  fireEvent.timeUpdate(audio);
  await waitFor(() =>
    expect(execute).toHaveBeenCalledWith({
      type: "MEDIA_EVENT",
      generation: snapshot.generation,
      event: "time",
      position: 5,
    }),
  );
  expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
});
it("offers Restart without a load and disables unavailable comparison on a standalone voice timeline", () => {
  const execute = vi.fn(async () => {});
  render(
    <PlayerPanel
      view={view({
        timeCoordinate: "voice-output",
        comparisonAvailable: false,
      })}
      execute={execute}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Restart" }));
  expect(execute).toHaveBeenCalledWith({ type: "RESTART" });
  expect(
    screen.getByText("Voice timeline; original comparison is unavailable."),
  ).toBeTruthy();
  expect(
    (
      screen.getByRole("button", {
        name: "Compare original",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
it("plays or removes only the selected repeated queue occurrence", () => {
  const execute = vi.fn(async () => {}),
    snapshot = view({ queue: ["one", "two", "one"] });
  render(<PlayerPanel view={snapshot} execute={execute} />);
  fireEvent.click(
    screen.getByRole("button", { name: "More playback controls" }),
  );
  const queued = screen.getAllByRole("button", { name: "Queued audio" });
  fireEvent.click(queued[2]!);
  expect(execute).toHaveBeenCalledWith({
    type: "QUEUE_PLAY",
    generation: snapshot.generation,
    queueRevision: snapshot.queueRevision,
    index: 2,
    trackId: "one",
  });
  fireEvent.click(
    screen.getAllByRole("button", { name: "Remove Audio from queue" })[2]!,
  );
  expect(execute).toHaveBeenCalledWith({
    type: "QUEUE_EDIT",
    action: "remove",
    index: 2,
    trackId: "one",
    generation: snapshot.generation,
    queueRevision: snapshot.queueRevision,
  });
  fireEvent.click(screen.getAllByRole("button", { name: "Move Audio up" })[2]!);
  expect(execute).toHaveBeenCalledWith({
    type: "QUEUE_EDIT",
    action: "move",
    index: 2,
    to: 1,
    trackId: "one",
    generation: snapshot.generation,
    queueRevision: snapshot.queueRevision,
  });
  expect(
    (
      screen.getAllByRole("button", {
        name: "Move Audio up",
      })[0] as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Clear queue" }));
  expect(execute).toHaveBeenCalledWith({
    type: "QUEUE_EDIT",
    action: "clear",
    generation: snapshot.generation,
    queueRevision: snapshot.queueRevision,
  });
});
it("accepts a bounded custom sleep duration with Arabic digits and preserves its draft across live snapshots", async () => {
  const execute = vi.fn(async () => {}),
    snapshot = view({
      listening: {
        loopStart: null,
        loopEnd: null,
        bookmarks: [],
        sleepRemainingSeconds: null,
        skipSilence: false,
        analyzingSilence: false,
        error: null,
      },
    });
  const { rerender } = render(
    <PlayerPanel view={snapshot} execute={execute} defaultExpanded />,
  );
  const input = await screen.findByLabelText("Custom sleep timer (minutes)");
  fireEvent.change(input, { target: { value: "٧" } });
  fireEvent.click(
    screen.getByRole("button", { name: "Set custom sleep timer" }),
  );
  expect(execute).toHaveBeenCalledWith({ type: "SLEEP", seconds: 420 });
  setLanguage("ar");
  rerender(
    <PlayerPanel
      view={{ ...snapshot, position: 13 }}
      execute={execute}
      defaultExpanded
    />,
  );
  expect(
    (screen.getByLabelText("مؤقّت نوم مخصّص (بالدقائق)") as HTMLInputElement)
      .value,
  ).toBe("٧");
  fireEvent.change(input, { target: { value: "720" } });
  fireEvent.click(
    screen.getByRole("button", { name: "ضبط مؤقّت النوم المخصّص" }),
  );
  expect(execute).toHaveBeenCalledWith({ type: "SLEEP", seconds: 43200 });
  for (const value of ["0", "721", "1.5", "-1", "1e2"]) {
    fireEvent.change(input, { target: { value } });
    expect(
      (
        screen.getByRole("button", {
          name: "ضبط مؤقّت النوم المخصّص",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  }
});
