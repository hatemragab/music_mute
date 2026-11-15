import { createHash, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type {
  ConsumerMutexLease,
  ConsumerMutexScope,
} from "../../worker/src/platform/windows/consumer-native-policy.js";
import { WindowsBookmarkStore } from "../src/main/player/bookmark-store.js";
import { AdvancedListening } from "../src/main/player/listening.js";
const sid = "S-1-5-21-1-2-3-1001";
function fixture() {
  const values = new Map<string, Buffer>();
  const identity = { sid },
    report = { installationId: randomUUID() };
  let held: ConsumerMutexLease | null = null;
  function helper() {
    return {
      vaultRead: vi.fn(async (_namespace: string, key: string) => {
        const bytes = values.get(key);
        return bytes ? Buffer.from(bytes) : null;
      }),
      vaultWrite: vi.fn(
        async (_namespace: string, key: string, bytes: Buffer) => {
          if (key.length > 64 || bytes.length > 16384)
            throw new Error("NATIVE_VALUE_LIMIT");
          values.set(key, Buffer.from(bytes));
        },
      ),
      vaultDelete: vi.fn(async (_namespace: string, key: string) => {
        values.delete(key);
      }),
      acquireMutex: vi.fn(
        async (
          scope: ConsumerMutexScope,
        ): Promise<ConsumerMutexLease | null> => {
          if (held) return null;
          held = {
            scope,
            nonce: "a".repeat(64),
            abandoned: false,
            identity: { pid: 100, creationTime: "123", sid, sessionId: 1 },
          };
          return structuredClone(held);
        },
      ),
      releaseMutex: vi.fn(async (lease: ConsumerMutexLease) => {
        expect(lease).toEqual(held);
        held = null;
      }),
    };
  }
  const native = helper();
  return {
    values,
    native,
    identity,
    report,
    store: new WindowsBookmarkStore({ identity, report, native }),
    another: (sameHelper = false) =>
      new WindowsBookmarkStore({
        identity,
        report,
        native: sameHelper ? native : helper(),
      }),
    headKey: (owner = "local", track = "one") =>
      `bm_${createHash("sha256")
        .update(
          JSON.stringify([identity.sid, report.installationId, owner, track]),
        )
        .digest("hex")
        .slice(0, 58)}`,
  };
}
function largeRecord() {
  return {
    version: 1,
    owner: "local",
    trackId: "one",
    skipSilencePreferred: true,
    bookmarks: Array.from({ length: 100 }, (_, seconds) => ({
      id: randomUUID(),
      seconds,
      title: "ص".repeat(80),
    })),
  };
}
function manifest(f: ReturnType<typeof fixture>) {
  return JSON.parse(f.values.get(f.headKey())!.toString()) as {
    slot: 0 | 1;
    parts: { bytes: number; sha256: string }[];
  };
}
function partKey(f: ReturnType<typeof fixture>, slot: number, index: number) {
  return `b${slot}_${f.headKey().slice(3)}_${index}`;
}
it("partitions private records by owner without native filenames containing owner or track", async () => {
  const f = fixture();
  await f.store.write("account-one", "local:one", {
    version: 1,
    bookmarks: [],
  });
  expect(await f.store.read("account-two", "local:one")).toBeNull();
  expect(await f.store.read("account-one", "local:one")).toEqual({
    version: 1,
    bookmarks: [],
  });
  expect([...f.values.keys()]).toHaveLength(2);
  expect(
    [...f.values.keys()].every((key) =>
      /^(bm_[a-f0-9]{58}|b[01]_[a-f0-9]{58}_[0-3])$/u.test(key),
    ),
  ).toBe(true);
  expect(f.native.acquireMutex).toHaveBeenCalledWith("metadata");
});
it("round trips all 100 bookmarks with 80 Arabic title units under the actual per-key cap", async () => {
  const f = fixture(),
    record = largeRecord();
  expect(Buffer.byteLength(JSON.stringify(record))).toBeGreaterThan(16384);
  await f.store.write("local", "one", record);
  expect(await f.another().read("local", "one")).toEqual(record);
  expect([...f.values.values()].every((bytes) => bytes.length <= 16384)).toBe(
    true,
  );
  const listening = new AdvancedListening(
    {
      pause() {},
      seek() {},
      repeatAt: async () => {},
      analyze: async () => [],
    },
    f.another(),
  );
  await listening.bind({
    trackId: "one",
    generation: "ready",
    ownerKey: "local",
    duration: 120,
    position: 0,
    variant: "voice",
    playing: false,
  });
  expect(listening.view().bookmarks).toEqual(record.bookmarks);
  expect(listening.view().error).toBeNull();
  listening.dispose();
});
it("reads legacy v1 bytes and migrates only after an explicit successful edit", async () => {
  const f = fixture(),
    old = Buffer.from(' { "version": 1, "bookmarks": [] } ');
  f.values.set(f.headKey(), old);
  expect(await f.store.read("local", "one")).toEqual({
    version: 1,
    bookmarks: [],
  });
  expect(f.native.vaultWrite).not.toHaveBeenCalled();
  await f.store.write("local", "one", {
    version: 1,
    bookmarks: [{ title: "new" }],
  });
  expect(manifest(f).slot).toBe(0);
  expect(await f.store.read("local", "one")).toEqual({
    version: 1,
    bookmarks: [{ title: "new" }],
  });
});
it("preserves exact legacy damaged bytes and rejects a changed quarantine source", async () => {
  const f = fixture(),
    raw = Buffer.from(' { "version": 99 } ');
  f.values.set(f.headKey(), raw);
  await f.store.read("local", "one");
  await f.store.quarantine("local", "one");
  expect(f.values.get(`bmbad_${f.headKey().slice(3)}`)).toEqual(raw);
  f.values.set(f.headKey(), Buffer.from("changed"));
  await expect(f.store.quarantine("local", "one")).rejects.toThrow(
    "PREFERENCES_UNAVAILABLE",
  );
});
it("bounds full records at 64 KiB and rejects invalid serialization before any writes", async () => {
  const f = fixture();
  for (const value of [{ text: "x".repeat(65536) }, undefined, { value: 1n }])
    await expect(f.store.write("local", "one", value)).rejects.toThrow(
      "PREFERENCES_UNAVAILABLE",
    );
  expect(f.native.vaultWrite).not.toHaveBeenCalled();
  const record = { text: "x".repeat(65525) };
  expect(Buffer.byteLength(JSON.stringify(record))).toBe(65536);
  await f.store.write("local", "one", record);
  expect(manifest(f).parts).toHaveLength(4);
  expect(await f.store.read("local", "one")).toEqual(record);
});
it.each(["part", "delete", "head"])(
  "retains the previous complete generation when %s fails before commit",
  async (where) => {
    const f = fixture();
    await f.store.write("local", "one", { text: "previous" });
    const old = Buffer.from(f.values.get(f.headKey())!);
    const write = f.native.vaultWrite.getMockImplementation()!,
      remove = f.native.vaultDelete.getMockImplementation()!;
    f.native.vaultWrite.mockImplementation(async (ns, key, bytes) => {
      if (
        (where === "part" && key.startsWith("b1_")) ||
        (where === "head" && key.startsWith("bm_"))
      )
        throw new Error("FAIL_BEFORE_COMMIT");
      await write(ns, key, bytes);
    });
    f.native.vaultDelete.mockImplementation(async (ns, key) => {
      if (where === "delete") throw new Error("FAIL_BEFORE_DELETE");
      await remove(ns, key);
    });
    await expect(
      f.store.write("local", "one", { text: "next" }),
    ).rejects.toThrow("PREFERENCES_UNAVAILABLE");
    expect(f.values.get(f.headKey())).toEqual(old);
    expect(await f.another().read("local", "one")).toEqual({
      text: "previous",
    });
  },
);
it("lost commit acknowledgement cannot blindly repeat or overwrite a committed generation", async () => {
  const f = fixture();
  await f.store.write("local", "one", { text: "previous" });
  const write = f.native.vaultWrite.getMockImplementation()!;
  f.native.vaultWrite.mockImplementation(async (ns, key, bytes) => {
    await write(ns, key, bytes);
    if (key.startsWith("bm_")) throw new Error("ACK_LOST");
  });
  await expect(
    f.store.write("local", "one", { text: "committed" }),
  ).rejects.toThrow("PREFERENCES_UNAVAILABLE");
  f.native.vaultWrite.mockImplementation(write);
  await expect(
    f.store.write("local", "one", { text: "blind retry" }),
  ).rejects.toThrow("PREFERENCES_UNAVAILABLE");
  expect(await f.store.read("local", "one")).toEqual({ text: "committed" });
  await f.store.write("local", "one", { text: "reviewed retry" });
});
it.each(["missing", "corrupt", "utf8"])(
  "preserves %s chunk evidence and requires quarantine before explicit repair",
  async (damage) => {
    const f = fixture();
    await f.store.write("local", "one", largeRecord());
    const m = manifest(f),
      key = partKey(f, m.slot, 0),
      head = Buffer.from(f.values.get(f.headKey())!);
    if (damage === "missing") f.values.delete(key);
    else if (damage === "corrupt") f.values.set(key, Buffer.from("changed"));
    else {
      const part = f.values.get(key)!;
      part[0] = 255;
      const parsed = JSON.parse(head.toString());
      parsed.parts[0].sha256 = createHash("sha256").update(part).digest("hex");
      parsed.sha256 = createHash("sha256")
        .update(
          Buffer.concat(
            parsed.parts.map((_p: unknown, i: number) =>
              f.values.get(partKey(f, m.slot, i))!,
            ),
          ),
        )
        .digest("hex");
      f.values.set(f.headKey(), Buffer.from(JSON.stringify(parsed)));
    }
    const damagedHead = Buffer.from(f.values.get(f.headKey())!),
      damagedPart = f.values.get(key);
    await expect(f.store.read("local", "one")).rejects.toThrow(
      "PREFERENCES_UNAVAILABLE",
    );
    await expect(f.store.write("local", "one", {})).rejects.toThrow(
      "PREFERENCES_UNAVAILABLE",
    );
    await f.store.quarantine("local", "one");
    expect(f.values.get(`bmbad_${f.headKey().slice(3)}`)).toEqual(damagedHead);
    expect(f.values.get(`bq_${f.headKey().slice(3)}_0`)).toEqual(damagedPart);
    await f.store.write("local", "one", { repaired: true });
    expect(await f.store.read("local", "one")).toEqual({ repaired: true });
  },
);
it("rejects duplicate manifest/record keys, malformed slots and unknown manifest fields", async () => {
  const f = fixture();
  for (const raw of [
    '{"version":1,"version":99}',
    '{"kind":"bookmark-parts","slot":0,"slot":1}',
    '{"kind":"bookmark-parts","version":2,"slot":3}',
  ]) {
    f.values.set(f.headKey(), Buffer.from(raw));
    await expect(f.store.read("local", "one")).rejects.toThrow(
      "PREFERENCES_UNAVAILABLE",
    );
  }
  await f.store.quarantine("local", "one");
  await f.store.write("local", "one", {});
  const head = JSON.parse(f.values.get(f.headKey())!.toString());
  f.values.set(
    f.headKey(),
    Buffer.from(JSON.stringify({ ...head, unknown: true })),
  );
  await expect(f.store.read("local", "one")).rejects.toThrow(
    "PREFERENCES_UNAVAILABLE",
  );
});
it("CAS rejects another writer including same-content ABA and requires an observed existing record", async () => {
  const f = fixture();
  await f.store.write("local", "one", { text: "old" });
  const stale = f.another();
  await stale.read("local", "one");
  await f.store.write("local", "one", { text: "new" });
  await f.store.write("local", "one", { text: "old" });
  await expect(stale.write("local", "one", { text: "stale" })).rejects.toThrow(
    "PREFERENCES_UNAVAILABLE",
  );
  await expect(f.another().write("local", "one", {})).rejects.toThrow(
    "PREFERENCES_UNAVAILABLE",
  );
  expect(await stale.read("local", "one")).toEqual({ text: "old" });
});
it("serializes a concurrent reader until inactive chunks and atomic head are committed", async () => {
  const f = fixture();
  await f.store.write("local", "one", largeRecord());
  const write = f.native.vaultWrite.getMockImplementation()!;
  let resume!: () => void, started!: () => void;
  const blocked = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.native.vaultWrite.mockImplementation(async (ns, key, bytes) => {
    if (key.startsWith("b1_") && key.endsWith("_0")) {
      started();
      await blocked;
    }
    await write(ns, key, bytes);
  });
  const writing = f.store.write("local", "one", { text: "new" });
  await entered;
  let readDone = false;
  const reading = f
    .another()
    .read("local", "one")
    .then((value) => {
      readDone = true;
      return value;
    });
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(readDone).toBe(false);
  resume();
  await writing;
  expect(await reading).toEqual({ text: "new" });
});
it("bounds generations to eight data values and prunes inactive trailing chunks", async () => {
  const f = fixture();
  for (let i = 0; i < 12; i++)
    await f.store.write("local", "one", {
      text: "x".repeat(i % 2 === 0 ? 60000 : 2),
      i,
    });
  expect([...f.values.keys()]).toHaveLength(6);
  expect(
    [...f.values.keys()].filter((key) => /^b[01]_/u.test(key)).length,
  ).toBeLessThanOrEqual(8);
  expect(await f.store.read("local", "one")).toEqual({ text: "xx", i: 11 });
});
it("rejects changed chunk quarantine input and never overwrites the current record", async () => {
  const f = fixture();
  await f.store.write("local", "one", largeRecord());
  const key = partKey(f, manifest(f).slot, 0);
  await f.store.read("local", "one");
  f.values.set(key, Buffer.from("different bytes"));
  await expect(f.store.quarantine("local", "one")).rejects.toThrow(
    "PREFERENCES_UNAVAILABLE",
  );
  await expect(f.store.write("local", "one", {})).rejects.toThrow(
    "PREFERENCES_UNAVAILABLE",
  );
  expect([...f.values.keys()].some((key) => key.startsWith("bmbad_"))).toBe(
    false,
  );
});
it("does not repair if exact quarantine commit fails", async () => {
  const f = fixture();
  f.values.set(f.headKey(), Buffer.from("{invalid}"));
  await expect(f.store.read("local", "one")).rejects.toThrow(
    "PREFERENCES_UNAVAILABLE",
  );
  const write = f.native.vaultWrite.getMockImplementation()!;
  f.native.vaultWrite.mockImplementation(async (ns, key, bytes) => {
    if (key.startsWith("bmbad_")) throw new Error("ARCHIVE_ACK_LOST");
    await write(ns, key, bytes);
  });
  await expect(f.store.quarantine("local", "one")).rejects.toThrow(
    "PREFERENCES_UNAVAILABLE",
  );
  await expect(f.store.write("local", "one", {})).rejects.toThrow(
    "PREFERENCES_UNAVAILABLE",
  );
  expect(f.values.get(f.headKey())?.toString()).toBe("{invalid}");
});
it("fences a host identity change before head commit and releases the exact metadata lease", async () => {
  const f = fixture(),
    write = f.native.vaultWrite.getMockImplementation()!;
  f.native.vaultWrite.mockImplementation(async (ns, key, bytes) => {
    await write(ns, key, bytes);
    f.identity.sid = "S-1-5-21-4-5-6-1001";
  });
  await expect(f.store.write("local", "one", {})).rejects.toThrow(
    "PREFERENCES_UNAVAILABLE",
  );
  expect([...f.values.keys()].some((key) => key.startsWith("bm_"))).toBe(false);
  expect(f.native.releaseMutex).toHaveBeenCalledOnce();
});
it("retries exact failed lease release before another operation and serializes same-helper stores", async () => {
  const f = fixture(),
    release = f.native.releaseMutex.getMockImplementation()!;
  f.native.releaseMutex.mockRejectedValueOnce(new Error("RELEASE_UNCONFIRMED"));
  await expect(f.store.write("local", "one", {})).rejects.toThrow(
    "PREFERENCES_UNAVAILABLE",
  );
  f.native.releaseMutex.mockImplementation(release);
  expect(await f.store.read("local", "one")).toEqual({});
  await Promise.all([
    f.store.read("local", "one"),
    f.another(true).read("local", "one"),
  ]);
  expect(f.native.releaseMutex).toHaveBeenCalledTimes(5);
});

it("rejects a whole-record hash mismatch even when every chunk hash is valid", async () => {
  const f = fixture();
  await f.store.write("local", "one", largeRecord());
  const head = JSON.parse(f.values.get(f.headKey())!.toString());
  head.sha256 = "0".repeat(64);
  f.values.set(f.headKey(), Buffer.from(JSON.stringify(head)));
  await expect(f.store.read("local", "one")).rejects.toThrow(
    "PREFERENCES_UNAVAILABLE",
  );
});
it("transport failure during chunk capture cannot authorize incomplete quarantine or repair", async () => {
  const f = fixture();
  await f.store.write("local", "one", largeRecord());
  const read = f.native.vaultRead.getMockImplementation()!,
    head = Buffer.from(f.values.get(f.headKey())!);
  f.native.vaultRead.mockImplementation(async (ns, key) => {
    if (key.startsWith("b0_") && key.endsWith("_1"))
      throw new Error("READ_UNCONFIRMED");
    return read(ns, key);
  });
  await expect(f.store.read("local", "one")).rejects.toThrow(
    "PREFERENCES_UNAVAILABLE",
  );
  f.native.vaultRead.mockImplementation(read);
  await expect(f.store.quarantine("local", "one")).rejects.toThrow(
    "PREFERENCES_UNAVAILABLE",
  );
  await expect(f.store.write("local", "one", {})).rejects.toThrow(
    "PREFERENCES_UNAVAILABLE",
  );
  expect(f.values.get(f.headKey())).toEqual(head);
  expect(await f.store.read("local", "one")).toEqual(
    expect.objectContaining({ bookmarks: expect.any(Array) }),
  );
});
it("quarantine chunk failure preserves current damaged bytes and forbids repair", async () => {
  const f = fixture();
  await f.store.write("local", "one", largeRecord());
  const key = partKey(f, manifest(f).slot, 0);
  f.values.set(key, Buffer.from("damaged"));
  await expect(f.store.read("local", "one")).rejects.toThrow(
    "PREFERENCES_UNAVAILABLE",
  );
  const write = f.native.vaultWrite.getMockImplementation()!,
    head = Buffer.from(f.values.get(f.headKey())!);
  f.native.vaultWrite.mockImplementation(async (ns, key, bytes) => {
    if (key.startsWith("bq_")) throw new Error("QUARANTINE_PART_UNCONFIRMED");
    await write(ns, key, bytes);
  });
  await expect(f.store.quarantine("local", "one")).rejects.toThrow(
    "PREFERENCES_UNAVAILABLE",
  );
  await expect(f.store.write("local", "one", {})).rejects.toThrow(
    "PREFERENCES_UNAVAILABLE",
  );
  expect(f.values.get(f.headKey())).toEqual(head);
  expect(f.values.get(key)?.toString()).toBe("damaged");
});
