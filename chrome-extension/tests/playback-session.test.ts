import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PlaybackSessionStore,
  PLAYBACK_SESSION_KEY,
  playbackCheckpoint,
} from "../src/extension/playback-session";

const checkpoint = {
  version: 1 as const,
  tabId: 17,
  documentId: "fixture-document",
  generation: 7,
  videoId: "abcdefghijk",
  durationSeconds: 19,
  requestId: "11111111-1111-4111-8111-111111111111",
  jobId: "22222222-2222-4222-8222-222222222222",
  savedAt: 10_000,
};
afterEach(() => vi.unstubAllGlobals());
describe("ephemeral playback recovery identity", () => {
  it.each([
    { savedAt: 10_001 },
    { savedAt: -8_000_000 },
    { documentId: "" },
    { tabId: -1 },
    { generation: NaN },
    { durationSeconds: Infinity },
    { jobId: "https://private.invalid/token" },
    { videoId: "invalid" },
  ])("rejects an expired or malformed identity %j", (patch) => {
    expect(playbackCheckpoint({ ...checkpoint, ...patch }, 10_000)).toBeNull();
  });
  it("projects identity without media, account data or unexpected fields", () => {
    expect(
      playbackCheckpoint(
        { ...checkpoint, media: "PRIVATE", token: "PRIVATE", owner: "PRIVATE" },
        10_000,
      ),
    ).toEqual(checkpoint);
  });
  it("serializes Stop after a pending save so old state cannot revive", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stored: Record<string, unknown> = {};
    const set = vi.fn(async (value: Record<string, unknown>) => {
      if (value[PLAYBACK_SESSION_KEY]) await blocked;
      Object.assign(stored, value);
    });
    vi.stubGlobal("chrome", {
      storage: { session: { set, get: async () => stored } },
    });
    const sessions = new PlaybackSessionStore();
    sessions.save({ ...checkpoint, savedAt: Date.now() });
    sessions.save(null);
    release();
    expect(await sessions.read()).toBeNull();
    expect(stored[PLAYBACK_SESSION_KEY]).toBeNull();
  });
});
