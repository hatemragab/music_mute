import { describe, expect, it, vi } from "vitest";
import { PlaybackController } from "../src/main/player/controller.js";
import type { PlaybackCommand } from "../src/shared/playback-contracts.js";
import { historyFixture, song } from "./history-fixtures.js";
import { ownerA, ownerB } from "./realtime-fixtures.js";
async function fixture() {
  const history = historyFixture();
  await history.controller.restore();
  await history.controller.reconcile([song]);
  const player = new PlaybackController(
    {
      open: async () => ({
        url: `http://127.0.0.1:12345/media/00000000-0000-4000-8000-000000000001?capability=${"a".repeat(43)}`,
        originalDuration: 10,
        sourceDuration: 10,
        trimmed: false,
        release: vi.fn(async () => {}),
      }),
    },
    history.controller.captureAccounting(),
    () => 0,
    {
      store: {
        read: async () => null,
        write: async () => {},
        quarantine: async () => {},
      },
      owner: () => ({ key: "local", fence: "guest" }),
    },
  );
  const event = (
    event: Extract<PlaybackCommand, { type: "MEDIA_EVENT" }>["event"],
    position = 0,
  ) =>
    player.execute({
      type: "MEDIA_EVENT",
      generation: player.view().generation,
      event,
      position,
    });
  return { history, player, event };
}
describe("real player / history source composition", () => {
  it("keeps a trusted guest track and its natural repeat counts in the Windows partition across sign-in, account switches and sign-out", async () => {
    const history = historyFixture(),
      guest = { ...song, accountOwned: false },
      account = { ...song, accountOwned: true };
    await history.controller.restore();
    await history.controller.setScope(ownerA);
    await history.controller.reconcile([guest, account]);
    const player = new PlaybackController({
      open: async () => ({
        url: `http://127.0.0.1:12345/media/00000000-0000-4000-8000-000000000001?capability=${"a".repeat(43)}`,
        originalDuration: 10,
        sourceDuration: 10,
        trimmed: false,
        accountOwned: false,
        accounting: history.controller.accountingFor(guest),
        release: async () => {},
      }),
    });
    const event = (kind: "playing" | "ended", position = 0) =>
      player.execute({
        type: "MEDIA_EVENT",
        generation: player.view().generation,
        event: kind,
        position,
      });
    await player.execute({ type: "LOAD", trackId: song.id });
    await event("playing");
    expect(history.controller.count(guest)).toBe(1);
    expect(history.controller.count(account)).toBe(0);
    await history.controller.setScope(ownerB);
    await history.controller.reconcile([guest, account]);
    await player.invalidateOwner(() => false);
    await player.execute({ type: "REPEAT", mode: "track" });
    await event("ended", 10);
    await event("playing");
    expect(history.controller.count(guest)).toBe(2);
    expect(history.controller.count(account)).toBe(0);
    await player.execute({ type: "SOURCE", variant: "original" });
    await event("playing");
    expect(history.controller.count(guest)).toBe(2);
    await history.controller.setScope(null);
    await event("ended", 10);
    await event("playing");
    expect(history.controller.count(guest)).toBe(3);
    await player.dispose();
    await history.controller.dispose();
  });
  it("counts actual starts while pause/resume, buffering, seeking and comparison keep one play", async () => {
    const f = await fixture();
    await f.player.execute({ type: "LOAD", trackId: song.id });
    expect(f.history.controller.count(song)).toBe(0);
    await f.event("loaded");
    await f.event("buffering");
    expect(f.history.controller.count(song)).toBe(0);
    await f.event("playing");
    await f.event("playing");
    await f.player.execute({ type: "PAUSE" });
    await f.player.execute({ type: "PLAY" });
    await f.event("playing");
    await f.player.execute({ type: "SEEK", seconds: 3 });
    await f.player.execute({ type: "SOURCE", variant: "original" });
    await f.event("playing", 3);
    expect(f.history.controller.count(song)).toBe(1);
    await f.player.dispose();
    await f.history.controller.dispose();
  });
  it("counts track repetition when it actually plays and ignores duplicate ended notifications", async () => {
    const f = await fixture();
    await f.player.execute({ type: "LOAD", trackId: song.id });
    await f.event("playing");
    await f.player.execute({ type: "REPEAT", mode: "track" });
    await f.event("ended", 10);
    await f.event("ended", 10);
    expect(f.history.controller.count(song)).toBe(1);
    await f.event("playing");
    expect(f.history.controller.count(song)).toBe(2);
    await f.player.dispose();
    await f.history.controller.dispose();
  });
  it("counts AB repetition only after the matching successful seek, never stale/duplicate seek callbacks", async () => {
    const f = await fixture();
    await f.player.execute({ type: "LOAD", trackId: song.id });
    await f.event("playing");
    await f.event("time", 1);
    await f.player.execute({ type: "LOOP_START" });
    await f.event("time", 4);
    await f.player.execute({ type: "LOOP_END" });
    await f.event("time", 4.1);
    const revision = f.player.view().seekRevision,
      generation = f.player.view().generation;
    expect(f.history.controller.count(song)).toBe(1);
    await f.player.execute({
      type: "MEDIA_EVENT",
      generation,
      event: "seeked",
      position: 1,
      seekRevision: revision - 1,
    });
    expect(f.history.controller.count(song)).toBe(1);
    await f.player.execute({
      type: "MEDIA_EVENT",
      generation,
      event: "seeked",
      position: 1,
      seekRevision: revision,
    });
    expect(f.history.controller.count(song)).toBe(2);
    await f.player.execute({
      type: "MEDIA_EVENT",
      generation,
      event: "seeked",
      position: 1,
      seekRevision: revision,
    });
    expect(f.history.controller.count(song)).toBe(2);
    await f.player.dispose();
    await f.history.controller.dispose();
  });
});
