import {
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TrustedSaveDestinations } from "../src/main/save-destinations.js";
import type {
  CreatedExportDiscardPort,
  CreatedExportDiscardRequest,
  ExportDestinationPreflight,
} from "../src/main/save-destinations.js";
import { fixtureCreatedExportDiscard } from "./export-discard-fixture.js";
const roots: string[] = [],
  registries: TrustedSaveDestinations[] = [];
it("claims benchmark consent before drain and retains it beyond the unused permission deadline", async () => {
  let now = 0;
  const { registry, path, owner, signal } = await setup(() => now);
  const cap = await registry.grant(
    "report.json",
    "Benchmark report",
    owner,
    signal,
    "report",
  );
  await expect(registry.claim(cap!, owner.id, "audio", signal)).rejects.toThrow(
    "EXPORT_UNAVAILABLE",
  );
  const lease = await registry.claim(cap!, owner.id, "report", signal);
  expect(registry.activity().claimed).toBe(1);
  now = 5 * 60_000;
  await lease.write(async (file) => {
    await file.writeFile('{"provider":"directml"}');
  }, signal);
  await lease.release();
  expect(registry.activity().idle).toBe(true);
  expect(await readFile(path, "utf8")).toBe('{"provider":"directml"}');
  await expect(
    registry.claim(cap!, owner.id, "report", signal),
  ).rejects.toThrow("EXPORT_UNAVAILABLE");
});
it("revokes claimed benchmark destinations when their window goes away without touching a foreign replacement", async () => {
  const { registry, path, owner, signal } = await setup();
  const cap = await registry.grant(
    "audio.zip",
    "Benchmark audio",
    owner,
    signal,
    "audio",
  );
  await registry.claim(cap!, owner.id, "audio", signal);
  await rename(path, `${path}.owned`);
  await writeFile(path, "foreign destination");
  await expect(registry.revokeOwner(owner.id)).rejects.toThrow(
    "EXPORT_UNAVAILABLE",
  );
  expect(await readFile(path, "utf8")).toBe("foreign destination");
  expect(registry.activity().claimed).toBe(1);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(
    registries.splice(0).map((registry) => registry.close()),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function setup(
  now?: () => number,
  reveal?: (path: string) => Promise<void>,
  discard: CreatedExportDiscardPort = fixtureCreatedExportDiscard(),
  validate?: ExportDestinationPreflight,
) {
  const root = await mkdtemp(join(tmpdir(), "musicmute-export-"));
  roots.push(root);
  const path = join(root, "report.zip"),
    registry = new TrustedSaveDestinations(
      async () => ({ canceled: false, filePath: path }),
      now,
      reveal,
      discard,
      validate,
    );
  registries.push(registry);
  const owner = { id: "window-a", current: () => true },
    signal = new AbortController().signal;
  return { registry, root, path, owner, signal };
}
it("rejects a failed native location preflight before creating any empty destination", async () => {
  const validate = vi.fn(async () => {
    throw new Error("PATH_UNSAFE");
  });
  const f = await setup(undefined, undefined, undefined, validate);
  await expect(
    f.registry.choose("voice.mp3", "Voice", f.owner, f.signal),
  ).rejects.toThrow("PATH_UNSAFE");
  expect(validate).toHaveBeenCalledWith(f.path);
  await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.registry.activity().idle).toBe(true);
});
it("awaits native preflight and refuses late retired-window consent before file creation", async () => {
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const validate = vi.fn(() => held);
  const f = await setup(undefined, undefined, undefined, validate);
  const choose = f.registry.choose("voice.mp3", "Voice", f.owner, f.signal);
  const rejected = expect(choose).rejects.toThrow();
  await vi.waitFor(() => expect(validate).toHaveBeenCalledOnce());
  let retired = false;
  const retirement = f.registry.revokeOwner(f.owner.id).then(() => {
    retired = true;
  });
  await Promise.resolve();
  expect(retired).toBe(false);
  await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  finish();
  await rejected;
  await retirement;
  await expect(readFile(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.registry.activity().idle).toBe(true);
});
it("reveals only a successfully saved report with its exact original bytes and owner", async () => {
  const reveal = vi.fn(async (_path: string) => {}),
    { registry, path, owner, signal } = await setup(undefined, reveal);
  const cap = await registry.grant("report.json", "Report", owner, signal);
  const receipt = await registry.writeReceipt(
    cap!,
    owner.id,
    Buffer.from('{"safe":true}'),
    signal,
  );
  await expect(registry.showReceipt(receipt, "other-owner")).rejects.toThrow(
    "EXPORT_UNAVAILABLE",
  );
  await registry.showReceipt(receipt, owner.id);
  expect(reveal).toHaveBeenCalledWith(path);
  await writeFile(path, '{"safe":false}');
  await expect(registry.showReceipt(receipt, owner.id)).rejects.toThrow(
    "EXPORT_UNAVAILABLE",
  );
  expect(reveal).toHaveBeenCalledOnce();
  await registry.revokeOwner(owner.id);
  await expect(registry.showReceipt(receipt, owner.id)).rejects.toThrow(
    "EXPORT_UNAVAILABLE",
  );
  expect(await readFile(path, "utf8")).toBe('{"safe":false}');
});
it("writes once through a chosen destination and rejects replay", async () => {
  const { registry, path, owner, signal } = await setup();
  const cap = await registry.grant("report.zip", "Export", owner, signal);
  await registry.write(
    cap!,
    owner.id,
    Buffer.from("sanitized fixture report"),
    signal,
  );
  expect(await readFile(path, "utf8")).toBe("sanitized fixture report");
  await expect(
    registry.write(cap!, owner.id, Buffer.from("replace"), signal),
  ).rejects.toThrow("EXPORT_UNAVAILABLE");
});
it("cannot overwrite an existing selected source", async () => {
  const { registry, path, owner, signal } = await setup();
  await writeFile(path, "keep source");
  await expect(
    registry.grant("report.zip", "Export", owner, signal),
  ).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe("keep source");
});
it("wrong owner cannot consume a grant and expired grants remove only their new file", async () => {
  let now = 0;
  const { registry, path, owner, signal } = await setup(() => now);
  const cap = await registry.grant("report.zip", "Export", owner, signal);
  await expect(
    registry.write(cap!, "other-window", Buffer.from("bad"), signal),
  ).rejects.toThrow("EXPORT_UNAVAILABLE");
  now = 60_000;
  await expect(
    registry.write(cap!, owner.id, Buffer.from("late"), signal),
  ).rejects.toThrow("EXPORT_UNAVAILABLE");
  await expect(readFile(path)).rejects.toThrow();
});
it("retains a replacement file when revoked consent no longer identifies its own destination", async () => {
  const { registry, path, owner, signal } = await setup();
  await registry.grant("report.zip", "Export", owner, signal);
  await rename(path, `${path}.owned`);
  await writeFile(path, "foreign replacement");
  await expect(registry.revokeOwner(owner.id)).rejects.toThrow(
    "EXPORT_UNAVAILABLE",
  );
  expect(await readFile(path, "utf8")).toBe("foreign replacement");
});
it("closing cancels a pending dialog and never creates a file from its late answer", async () => {
  const { path, owner, signal } = await setup();
  let reply!: (value: { canceled: boolean; filePath: string }) => void;
  const registry = new TrustedSaveDestinations(
    () =>
      new Promise((resolve) => {
        reply = resolve;
      }),
  );
  registries.push(registry);
  const choosing = registry.choose("report.zip", "Export", owner, signal);
  const failed = expect(choosing).rejects.toThrow("EXPORT_UNAVAILABLE");
  await Promise.resolve();
  await registry.close();
  await failed;
  reply({ canceled: false, filePath: path });
  await expect(readFile(path)).rejects.toThrow();
});
it("losing the originating window discards the new file instead of committing", async () => {
  const { registry, path, signal } = await setup();
  let current = true;
  const owner = { id: "window-a", current: () => current };
  const cap = await registry.grant("report.zip", "Export", owner, signal);
  current = false;
  await expect(
    registry.write(cap!, owner.id, Buffer.from("private"), signal),
  ).rejects.toThrow("EXPORT_UNAVAILABLE");
  await expect(readFile(path)).rejects.toThrow();
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it("retirement waits for a consumed grant's actual held writer despite a still-current UI predicate", async () => {
  const { registry, path, owner, signal } = await setup();
  const held = deferred<void>();
  const entered = deferred<void>();
  const choose = registry.choose.bind(registry);
  vi.spyOn(registry, "choose").mockImplementation(async (...args) => {
    const destination = await choose(...args);
    if (destination) {
      const write = destination.file.writeFile.bind(destination.file);
      vi.spyOn(destination.file, "writeFile").mockImplementation(
        async (bytes) => {
          entered.resolve();
          await held.promise;
          await write(bytes);
        },
      );
    }
    return destination;
  });
  const cap = await registry.grant("report.zip", "Report", owner, signal);
  const writing = registry.write(
    cap!,
    owner.id,
    Buffer.from("owned pending bytes"),
    signal,
  );
  const failure = expect(writing).rejects.toThrow("EXPORT_UNAVAILABLE");
  await entered.promise;
  expect(registry.activity().grants).toBe(0);
  let retired = false;
  const retirement = registry.revokeOwner(owner.id).then(() => {
    retired = true;
  });
  await Promise.resolve();
  expect(retired).toBe(false);
  expect(registry.activity().idle).toBe(false);
  await expect(
    registry.choose("new.zip", "Report", owner, signal),
  ).rejects.toThrow("EXPORT_UNAVAILABLE");
  held.resolve();
  await failure;
  await retirement;
  expect(registry.activity().idle).toBe(true);
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("retains raw chosen destinations, coalesces failed discard, and retries the exact descriptor without reviving consent", async () => {
  const { registry, path, owner, signal } = await setup();
  const destination = (await registry.choose(
    "file.zip",
    "Export",
    owner,
    signal,
  ))!;
  expect(registry.activity().grants).toBe(0);
  expect(registry.activity().idle).toBe(false);
  const close = vi
    .spyOn(destination.file, "close")
    .mockRejectedValueOnce(new Error("PRIVATE_CLOSE_PATH_FIXTURE"));
  const first = destination.discard();
  expect(destination.discard()).toBe(first);
  await expect(first).rejects.toThrow("EXPORT_UNAVAILABLE");
  expect(registry.activity().retained).toBe(1);
  await expect(destination.commit()).rejects.toThrow("EXPORT_UNAVAILABLE");
  close.mockRestore();
  await registry.revokeOwner(owner.id);
  expect(registry.activity().idle).toBe(true);
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("retirement is settle-all, retains a failed cleanup, and retries only that exact resource", async () => {
  const { registry, owner, signal } = await setup();
  const held = deferred<void>();
  const entered = deferred<void>();
  const fast = vi
    .fn()
    .mockRejectedValueOnce(new Error("PRIVATE_DISCARD_ERROR"))
    .mockResolvedValue(undefined);
  const slow = vi.fn(async () => {
    entered.resolve();
    await held.promise;
  });
  await registry.runOwned(owner, signal, async (_signal, retain) => {
    retain(fast);
    retain(slow);
  });
  let finished = false;
  const retirement = registry.revokeOwner(owner.id).finally(() => {
    finished = true;
  });
  const failure = expect(retirement).rejects.toThrow("EXPORT_UNAVAILABLE");
  await entered.promise;
  expect(finished).toBe(false);
  held.resolve();
  await failure;
  expect(registry.activity().retained).toBe(1);
  await registry.revokeOwner(owner.id);
  expect(fast).toHaveBeenCalledTimes(2);
  expect(slow).toHaveBeenCalledTimes(1);
  expect(registry.activity().idle).toBe(true);
});

it("a failed claimed release retains its retry and refuses a foreign name until original birth is restored", async () => {
  const { registry, path, owner, signal } = await setup();
  const cap = await registry.grant(
    "report.json",
    "Report",
    owner,
    signal,
    "report",
  );
  const lease = await registry.claim(cap!, owner.id, "report", signal);
  await rename(path, `${path}.owned`);
  await writeFile(path, "foreign replacement");
  await expect(lease.release()).rejects.toThrow("EXPORT_UNAVAILABLE");
  expect(registry.activity().claimed).toBe(1);
  await expect(registry.revokeOwner(owner.id)).rejects.toThrow(
    "EXPORT_UNAVAILABLE",
  );
  expect(await readFile(path, "utf8")).toBe("foreign replacement");
  await rename(path, `${path}.foreign`);
  await rename(`${path}.owned`, path);
  await registry.revokeOwner(owner.id);
  expect(registry.activity().idle).toBe(true);
  expect(await readFile(`${path}.foreign`, "utf8")).toBe("foreign replacement");
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("owner retirement cancels its late dialog and cannot cancel a new owner's export", async () => {
  const { root, signal } = await setup();
  const late = deferred<{ canceled: boolean; filePath: string }>();
  const entered = deferred<void>();
  const pathA = join(root, "a.zip"),
    pathB = join(root, "b.zip");
  const registry = new TrustedSaveDestinations(
    async (name) => {
      if (name === "a.zip") {
        entered.resolve();
        return late.promise;
      }
      return { canceled: false, filePath: pathB };
    },
    undefined,
    undefined,
    fixtureCreatedExportDiscard(),
  );
  registries.push(registry);
  const a = { id: "a", current: () => true },
    b = { id: "b", current: () => true };
  const choosing = registry.choose("a.zip", "A", a, signal);
  const failure = expect(choosing).rejects.toThrow("EXPORT_UNAVAILABLE");
  await entered.promise;
  const retirement = registry.revokeOwner(a.id);
  const cap = await registry.grant("b.zip", "B", b, signal);
  await registry.write(cap!, b.id, Buffer.from("new owner bytes"), signal);
  await retirement;
  await failure;
  late.resolve({ canceled: false, filePath: pathA });
  await Promise.resolve();
  await expect(readFile(pathA)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(pathB, "utf8")).toBe("new owner bytes");
  await expect(registry.grant("a.zip", "A", a, signal)).rejects.toThrow(
    "EXPORT_UNAVAILABLE",
  );
});

it("failed global closure keeps exact cleanup reachable for a later positive retry", async () => {
  const { registry, owner, signal } = await setup();
  const cleanup = vi
    .fn()
    .mockRejectedValueOnce(new Error("PRIVATE_CLOSE_ERROR"))
    .mockResolvedValue(undefined);
  await registry.runOwned(owner, signal, async (_signal, retain) => {
    retain(cleanup);
  });
  await expect(registry.close()).rejects.toThrow("EXPORT_UNAVAILABLE");
  expect(registry.activity().idle).toBe(false);
  await registry.close();
  expect(cleanup).toHaveBeenCalledTimes(2);
  expect(registry.activity().idle).toBe(true);
});
it("discard fences consent synchronously before the asynchronous cleanup begins", async () => {
  const { registry, path, owner, signal } = await setup();
  const destination = (await registry.choose(
    "report.zip",
    "Export",
    owner,
    signal,
  ))!;
  const discard = destination.discard();
  await expect(destination.commit()).rejects.toThrow("EXPORT_UNAVAILABLE");
  await discard;
  expect(registry.activity().idle).toBe(true);
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
});
it("completed window cycles are collectible without reviving issued owner, destination or claim consent", async () => {
  const { registry, owner, signal } = await setup();
  const cap = await registry.grant(
    "report.json",
    "Report",
    owner,
    signal,
    "report",
  );
  const lease = await registry.claim(cap!, owner.id, "report", signal);
  await registry.revokeOwner(owner.id);
  expect(registry.activity().owners).toBe(0);
  for (let index = 0; index < 300; index++) {
    const current = { id: `window-${index}`, current: () => true };
    await registry.runOwned(current, signal, async () => {});
    await registry.revokeOwner(current.id);
    expect(registry.activity().owners).toBe(0);
  }
  await expect(
    registry.choose("old.zip", "Export", owner, signal),
  ).rejects.toThrow("EXPORT_UNAVAILABLE");
  await expect(lease.write(async () => {}, signal)).rejects.toThrow(
    "EXPORT_UNAVAILABLE",
  );
  await expect(
    registry.claim(cap!, owner.id, "report", signal),
  ).rejects.toThrow("EXPORT_UNAVAILABLE");
  const fresh = { id: "new-window", current: () => true };
  await registry.runOwned(fresh, signal, async () => {});
  await registry.revokeOwner(fresh.id);
  expect(registry.activity().idle).toBe(true);
});
it("failed retirement stays retained while unrelated completed window history is collected", async () => {
  const { registry, owner, signal } = await setup();
  let permitCleanup = false;
  const cleanup = vi.fn(async () => {
    if (!permitCleanup) throw new Error("FIXTURE_CLOSE_PENDING");
  });
  try {
    await registry.runOwned(owner, signal, async (_signal, retain) => {
      retain(cleanup);
    });
    await expect(registry.revokeOwner(owner.id)).rejects.toThrow(
      "EXPORT_UNAVAILABLE",
    );
    for (let index = 0; index < 30; index++) {
      const current = { id: `replacement-${index}`, current: () => true };
      await registry.runOwned(current, signal, async () => {});
      await registry.revokeOwner(current.id);
      expect(registry.activity().owners).toBe(1);
      expect(registry.activity().retained).toBe(1);
    }
    permitCleanup = true;
    await registry.revokeOwner(owner.id);
    expect(registry.activity().owners).toBe(0);
    expect(registry.activity().idle).toBe(true);
  } finally {
    permitCleanup = true;
  }
});

it("fails closed without a native created-export discard port and retains the closed file for proof", async () => {
  const { path, owner, signal } = await setup();
  const registry = new TrustedSaveDestinations(async () => ({
    canceled: false,
    filePath: path,
  }));
  registries.push(registry);
  const destination = (await registry.choose(
    "report.zip",
    "Export",
    owner,
    signal,
  ))!;
  await destination.file.writeFile("partial owned export");
  await expect(destination.discard()).rejects.toThrow("EXPORT_UNAVAILABLE");
  await expect(destination.file.stat()).rejects.toThrow();
  expect(await readFile(path, "utf8")).toBe("partial owned export");
  expect(registry.activity().retained).toBe(1);
  await expect(registry.revokeOwner(owner.id)).rejects.toThrow(
    "EXPORT_UNAVAILABLE",
  );
});

it("reuses one frozen closed-descriptor fingerprint until native pending cleanup positively completes", async () => {
  const requests: Readonly<CreatedExportDiscardRequest>[] = [];
  const receiver = fixtureCreatedExportDiscard();
  const discard: CreatedExportDiscardPort = async (request) => {
    requests.push(request);
    return requests.length === 1 ? { state: "pending" } : receiver(request);
  };
  const { registry, path, owner, signal } = await setup(
    undefined,
    undefined,
    discard,
  );
  const destination = (await registry.choose(
    "report.zip",
    "Export",
    owner,
    signal,
  ))!;
  await destination.file.writeFile("exact created bytes");
  await expect(destination.discard()).rejects.toThrow("EXPORT_UNAVAILABLE");
  await expect(destination.file.stat()).rejects.toThrow();
  expect(requests[0]).toMatchObject({ path, bytes: 19 });
  expect(requests[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(Object.isFrozen(requests[0])).toBe(true);
  expect(Object.isFrozen(requests[0]!.birth)).toBe(true);
  expect(registry.activity().idle).toBe(false);
  await registry.revokeOwner(owner.id);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toBe(requests[0]);
  expect(registry.activity().idle).toBe(true);
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("reconciles lost native completion ACK with the original proof without deleting a later replacement", async () => {
  const requests: Readonly<CreatedExportDiscardRequest>[] = [];
  const receiver = fixtureCreatedExportDiscard();
  const discard: CreatedExportDiscardPort = async (request) => {
    requests.push(request);
    const result = await receiver(request);
    if (requests.length === 1) throw new Error("PRIVATE_NATIVE_ACK_LOST");
    return result;
  };
  const { registry, path, owner, signal } = await setup(
    undefined,
    undefined,
    discard,
  );
  const destination = (await registry.choose(
    "report.zip",
    "Export",
    owner,
    signal,
  ))!;
  await expect(destination.discard()).rejects.toThrow("EXPORT_UNAVAILABLE");
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(path, "new foreign replacement after certified deletion");
  await registry.revokeOwner(owner.id);
  expect(requests[1]).toBe(requests[0]);
  expect(await readFile(path, "utf8")).toBe(
    "new foreign replacement after certified deletion",
  );
  expect(registry.activity().idle).toBe(true);
});

it("never treats external disappearance or a post-precheck replacement as a discard certificate", async () => {
  const receiver = fixtureCreatedExportDiscard();
  let first = true;
  const discard: CreatedExportDiscardPort = async (request) => {
    if (first) {
      first = false;
      await rename(request.path, `${request.path}.original`);
      await writeFile(request.path, "foreign replaced after caller precheck");
    }
    return receiver(request);
  };
  const { registry, path, owner, signal } = await setup(
    undefined,
    undefined,
    discard,
  );
  const destination = (await registry.choose(
    "report.zip",
    "Export",
    owner,
    signal,
  ))!;
  await expect(destination.discard()).rejects.toThrow("EXPORT_UNAVAILABLE");
  expect(await readFile(path, "utf8")).toBe(
    "foreign replaced after caller precheck",
  );
  await unlink(path);
  await expect(registry.revokeOwner(owner.id)).rejects.toThrow(
    "EXPORT_UNAVAILABLE",
  );
  expect(registry.activity().retained).toBe(1);
  expect(registry.activity().idle).toBe(false);
  expect(await readFile(`${path}.original`)).toEqual(Buffer.alloc(0));
});

it("retains failed receipt acknowledgment and retries it without another delete or growing retired owner history", async () => {
  const receiver = fixtureCreatedExportDiscard();
  const acknowledge = vi
    .fn()
    .mockRejectedValueOnce(new Error("PRIVATE_ACK_FAILURE"));
  const discard = vi.fn<CreatedExportDiscardPort>(async (request) => {
    const completed = await receiver(request);
    if (completed.state !== "completed") throw new Error("FIXTURE_INCOMPLETE");
    acknowledge.mockImplementationOnce(completed.acknowledge);
    return { state: "completed", acknowledge };
  });
  const { registry, path, owner, signal } = await setup(
    undefined,
    undefined,
    discard,
  );
  const destination = (await registry.choose(
    "report.zip",
    "Export",
    owner,
    signal,
  ))!;
  await expect(destination.discard()).rejects.toThrow("EXPORT_UNAVAILABLE");
  expect(registry.activity().retained).toBe(1);
  await writeFile(path, "new replacement after completed deletion");
  await registry.revokeOwner(owner.id);
  expect(discard).toHaveBeenCalledTimes(1);
  expect(acknowledge).toHaveBeenCalledTimes(2);
  expect(registry.activity()).toMatchObject({
    idle: true,
    retained: 0,
    owners: 0,
  });
  expect(await readFile(path, "utf8")).toBe(
    "new replacement after completed deletion",
  );
});
