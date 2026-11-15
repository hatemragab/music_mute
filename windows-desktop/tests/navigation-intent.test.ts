import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { NavigationIntentCoordinator } from "../src/main/navigation-intent.js";
import { SectionStore } from "../src/main/section-store.js";
import type { Section } from "../src/shared/contracts.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it("unrelated snapshot publications cannot suppress the saved page restore", async () => {
  const coordinator = new NavigationIntentCoordinator();
  const read = deferred<Section>();
  const store = { read: () => read.promise, write: vi.fn() };
  let snapshot = { section: "home" as Section, sequence: 0 };
  const restore = coordinator.restore(store, (section) => {
    snapshot = { section, sequence: snapshot.sequence + 1 };
  });
  snapshot = { ...snapshot, sequence: snapshot.sequence + 3 };
  read.resolve("library");
  await restore;
  expect(snapshot).toEqual({ section: "library", sequence: 4 });
  expect(coordinator.hasIntent()).toBe(false);
  expect(store.write).not.toHaveBeenCalled();
});

it("an explicit intent predating restore wins even when default preferences disable the last page", async () => {
  const coordinator = new NavigationIntentCoordinator();
  const token = coordinator.record("settings");
  const write = deferred<void>();
  const store = {
    read: vi.fn(async () => "home" as const),
    write: vi.fn(() => write.promise),
  };
  const publish = vi.fn();
  const restore = coordinator.restore(store, publish);
  expect(store.read).not.toHaveBeenCalled();
  expect(store.write).toHaveBeenCalledWith("settings");
  expect(publish).not.toHaveBeenCalled();
  write.resolve();
  await restore;
  expect(publish.mock.calls).toEqual([["settings"]]);
  expect(coordinator.current(token)).toBe(true);
  expect(Object.isFrozen(token)).toBe(true);
});

it("intent arriving during a saved read replaces the old page only after its actual write", async () => {
  const coordinator = new NavigationIntentCoordinator();
  const read = deferred<Section>();
  const write = deferred<void>();
  const store = { read: () => read.promise, write: vi.fn(() => write.promise) };
  const publish = vi.fn();
  const restore = coordinator.restore(store, publish);
  coordinator.record("account");
  read.resolve("library");
  await Promise.resolve();
  expect(store.write).toHaveBeenCalledWith("account");
  expect(publish).not.toHaveBeenCalled();
  write.resolve();
  await restore;
  expect(publish.mock.calls).toEqual([["account"]]);
});

it("a newer intent during persistence prevents an older navigation completion from publishing", async () => {
  const coordinator = new NavigationIntentCoordinator();
  const first = coordinator.record("account");
  const write = deferred<void>();
  const store = {
    read: vi.fn(),
    write: vi
      .fn()
      .mockImplementationOnce(() => write.promise)
      .mockResolvedValue(undefined),
  };
  const publish = vi.fn();
  const restore = coordinator.restore(store, publish);
  const next = coordinator.record("setup");
  write.resolve();
  await restore;
  expect(store.write.mock.calls).toEqual([["account"], ["setup"]]);
  expect(publish.mock.calls).toEqual([["setup"]]);
  expect(coordinator.current(first)).toBe(false);
  expect(coordinator.current(next)).toBe(true);
});

it("real serialized SectionStore writes preserve the newest explicit navigation and suppress a queued old completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "musicmute-navigation-"));
  try {
    const coordinator = new NavigationIntentCoordinator();
    const store = new SectionStore(join(root, "ui-navigation.json"));
    const publish = vi.fn();
    const navigate = async (section: Section) => {
      const token = coordinator.record(section);
      await store.write(section);
      if (coordinator.current(token)) publish(section);
    };
    await Promise.all([navigate("account"), navigate("diagnostics")]);
    expect(publish.mock.calls).toEqual([["diagnostics"]]);
    expect(await store.read()).toBe("diagnostics");
    expect(coordinator.current({ section: "diagnostics" })).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reentrant navigation from saved-page publication is persisted without a later old-page overwrite", async () => {
  const coordinator = new NavigationIntentCoordinator();
  const store = {
    read: async () => "library" as const,
    write: vi.fn(async (_section: Section) => {}),
  };
  const publications: Section[] = [];
  await coordinator.restore(store, (section) => {
    publications.push(section);
    if (section === "library") coordinator.record("settings");
    if (section === "settings") coordinator.record("worker");
  });
  expect(publications).toEqual(["library", "settings", "worker"]);
  expect(store.write.mock.calls).toEqual([["settings"], ["worker"]]);
});

it("the superseded restore cannot publish after the newer restore has settled", async () => {
  const coordinator = new NavigationIntentCoordinator();
  const first = deferred<Section>();
  const second = deferred<Section>();
  const store = {
    read: vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise),
    write: vi.fn(),
  };
  const publish = vi.fn();
  const oldRestore = coordinator.restore(store, publish);
  const newRestore = coordinator.restore(store, publish);
  second.resolve("worker");
  await newRestore;
  first.resolve("library");
  await oldRestore;
  expect(publish.mock.calls).toEqual([["worker"]]);
});

it("write failure remains a rejected explicit restore rather than a successful fallback publication", async () => {
  const coordinator = new NavigationIntentCoordinator();
  const token = coordinator.record("settings");
  const store = {
    read: vi.fn(),
    write: vi.fn(async () => {
      throw new Error("FIXTURE_DISK_FULL");
    }),
  };
  const publish = vi.fn();
  await expect(coordinator.restore(store, publish)).rejects.toThrow(
    "FIXTURE_DISK_FULL",
  );
  expect(publish).not.toHaveBeenCalled();
  expect(coordinator.current(token)).toBe(true);
});

it("unknown navigation cannot replace an existing valid token", () => {
  const coordinator = new NavigationIntentCoordinator();
  const token = coordinator.record("home");
  expect(() => coordinator.record("arbitrary" as Section)).toThrow(
    "INVALID_REQUEST",
  );
  expect(coordinator.current(token)).toBe(true);
});
