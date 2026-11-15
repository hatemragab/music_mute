import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import type { JobView } from "../api/types";
import { readLibraryPreferences } from "../library/preferences";
import { PlayerProvider, usePlayer } from "./PlayerProvider";

const { auth, grant } = vi.hoisted(() => ({
  auth: { api: {}, user: { uid: "player-owner" } },
  grant: vi.fn(),
}));
vi.mock("../auth/AuthProvider", () => ({ useSignedIn: () => auth }));
vi.mock("../api/jobs", () => ({ jobsApi: () => ({ grant }) }));

class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = [];
  constructor() {
    super();
    FakeAudio.instances.push(this);
  }
  private source = "";
  set src(value: string) {
    this.source = value;
    this.currentTime = 0;
    this.ended = false;
  }
  get src() {
    return this.source;
  }
  currentTime = 0;
  duration = 90;
  playbackRate = 1;
  volume = 1;
  paused = true;
  seeking = false;
  ended = false;
  error = null;
  play = vi.fn(async () => {
    if (!this.source) throw new Error("no media source");
    this.paused = false;
    this.ended = false;
    this.dispatchEvent(new Event("play"));
  });
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  removeAttribute() {
    this.source = "";
  }
  load() {}
}
const job = { id: "one", canDownloadInput: true } as JobView;
const other = { id: "two", canDownloadInput: true } as JobView;
const wrapper = ({ children }: { children: ReactNode }) => (
  <PlayerProvider>{children}</PlayerProvider>
);
const counts = () => readLibraryPreferences(auth.user.uid).playCounts;
const element = () => FakeAudio.instances.at(-1)!;
beforeEach(() => {
  localStorage.clear();
  FakeAudio.instances = [];
  auth.user = { uid: "player-owner" };
  vi.stubGlobal("Audio", FakeAudio);
  grant.mockReset().mockResolvedValue({
    url: "https://media.example/fixture",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("successful starts count once; pause/resume, seeks, and original comparison do not", async () => {
  const hook = renderHook(usePlayer, { wrapper });
  await act(() => hook.result.current.play(job, [job, other]));
  expect(counts()).toEqual({ one: 1 });
  await act(() => hook.result.current.toggle());
  await act(() => hook.result.current.toggle());
  act(() => hook.result.current.seek(20));
  await act(() => hook.result.current.selectOriginal(true));
  expect(counts()).toEqual({ one: 1 });
  await act(() => hook.result.current.next());
  expect(counts()).toEqual({ one: 1, two: 1 });
});

test("failed and superseded starts do not count, and a failed start can later play once", async () => {
  const hook = renderHook(usePlayer, { wrapper });
  element().play.mockRejectedValueOnce(new Error("blocked"));
  await act(() => hook.result.current.play(job));
  expect(counts()).toEqual({});
  await act(() => hook.result.current.toggle());
  expect(counts()).toEqual({ one: 1 });
  let resolve!: (value: { url: string; expiresAt: string }) => void;
  grant.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  let late!: Promise<void>;
  act(() => {
    late = hook.result.current.play(other);
  });
  await act(() => hook.result.current.play(job));
  await act(async () => {
    resolve({
      url: "https://media.example/late",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await late;
  });
  expect(counts()).toEqual({ one: 2 });
});

test("automatic repeat and passage loop replay count after successful playback", async () => {
  const hook = renderHook(usePlayer, { wrapper });
  await act(() => hook.result.current.play(job));
  act(() => hook.result.current.setRepeat("one"));
  await act(async () => {
    element().dispatchEvent(new Event("ended"));
  });
  expect(counts()).toEqual({ one: 2 });
  act(() => {
    element().currentTime = 10;
    hook.result.current.toggleLoop();
  });
  act(() => {
    element().currentTime = 25;
    element().dispatchEvent(new Event("timeupdate"));
  });
  expect(element().currentTime).toBe(10);
  act(() => {
    element().currentTime = 11;
    element().dispatchEvent(new Event("timeupdate"));
  });
  expect(counts()).toEqual({ one: 3 });
  act(() => {
    hook.result.current.seek(25);
    element().dispatchEvent(new Event("timeupdate"));
  });
  act(() => {
    element().currentTime = 11;
    element().dispatchEvent(new Event("timeupdate"));
  });
  expect(counts()).toEqual({ one: 3 });
});

test("account change fences an outstanding media grant", async () => {
  const hook = renderHook(usePlayer, { wrapper });
  let resolve!: (value: { url: string; expiresAt: string }) => void;
  grant.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  let pending!: Promise<void>;
  act(() => {
    pending = hook.result.current.play(job);
  });
  auth.user = { uid: "other-owner" };
  hook.rerender();
  await act(async () => {
    resolve({
      url: "https://media.example/old",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await pending;
  });
  expect(readLibraryPreferences("player-owner").playCounts).toEqual({});
  expect(counts()).toEqual({});
});

test("failed track preparation cannot resume or credit audio left over from the previous track", async () => {
  const hook = renderHook(usePlayer, { wrapper });
  await act(() => hook.result.current.play(job, [job, other]));
  grant.mockRejectedValueOnce(new Error("network"));
  await act(() => hook.result.current.play(other, [job, other]));
  expect(element().src).toBe("");
  expect(counts()).toEqual({ one: 1 });
  await act(() => hook.result.current.toggle());
  expect(counts()).toEqual({ one: 1, two: 1 });
});

test("late resume failure cannot replace a newer selected track", async () => {
  const hook = renderHook(usePlayer, { wrapper });
  await act(() => hook.result.current.play(job, [job, other]));
  await act(() => hook.result.current.toggle());
  let reject!: (reason: Error) => void;
  element().play.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  let resume!: Promise<void>;
  act(() => {
    resume = hook.result.current.toggle();
  });
  await act(() => hook.result.current.next());
  await act(async () => {
    reject(new Error("old resume"));
    await resume;
  });
  expect(hook.result.current.current?.id).toBe("two");
  expect(hook.result.current.error).toBeNull();
  expect(counts()).toEqual({ one: 1, two: 1 });
});

test("late passage-loop failure cannot mark a newer successful track as failed", async () => {
  const hook = renderHook(usePlayer, { wrapper });
  await act(() => hook.result.current.play(job, [job, other]));
  act(() => hook.result.current.toggleLoop());
  let reject!: (reason: Error) => void;
  element().play.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  act(() => {
    element().dispatchEvent(new Event("ended"));
  });
  await act(() => hook.result.current.next());
  await act(async () => {
    reject(new Error("old loop"));
  });
  expect(hook.result.current.current?.id).toBe("two");
  expect(hook.result.current.error).toBeNull();
  expect(counts()).toEqual({ one: 1, two: 1 });
});
