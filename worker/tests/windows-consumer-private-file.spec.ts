import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { WindowsConsumerNative } from "../src/platform/windows/consumer-native.js";
import {
  openConsumerPrivateFile,
  PRIVATE_FILE_CHUNK_BYTES,
  PRIVATE_FILE_MAX_BYTES,
} from "../src/platform/windows/consumer-private-file.js";
import type {
  ConsumerNativeOperation,
  ConsumerNativeTransport,
} from "../src/platform/windows/consumer-native-transport.js";
import { ConsumerNativeChildTransport } from "../src/platform/windows/consumer-native-transport.js";

const token = "a".repeat(64);
function fixture(initial = Buffer.alloc(0)) {
  let bytes = Buffer.from(initial),
    shortWrite = Infinity;
  const birth = { device: "7", file_id: "9", born_at: "1700000000000000000" };
  const info = () => ({
    ...birth,
    bytes: bytes.length,
    written_at: "1700000000000000001",
    changed_at: "1700000000000000002",
  });
  const request = vi.fn(
    async (
      operation: ConsumerNativeOperation,
      args: Record<string, unknown>,
    ): Promise<unknown> => {
      if (
        operation === "private_file_open" ||
        operation === "store_fixture_file_open"
      )
        return { state: "opened", token, identity: info() };
      expect(args.token).toBe(token);
      if (operation === "private_file_info") return { identity: info() };
      if (operation === "private_file_read") {
        const chunk = bytes.subarray(
          Number(args.position),
          Number(args.position) + Number(args.length),
        );
        return {
          bytes_base64: chunk.toString("base64"),
          bytes_read: chunk.length,
        };
      }
      if (operation === "private_file_write") {
        const input = Buffer.from(String(args.bytes_base64), "base64"),
          count = Math.min(input.length, shortWrite),
          start = Number(args.position);
        if (start + count > bytes.length) {
          const next = Buffer.alloc(start + count);
          bytes.copy(next);
          bytes = next;
        }
        input.copy(bytes, start, 0, count);
        return { bytes_written: count };
      }
      if (operation === "private_file_truncate") {
        const next = Buffer.alloc(Number(args.length));
        bytes.copy(next);
        bytes = next;
        return { identity: info() };
      }
      if (operation === "private_file_sync")
        return { synced: true, identity: info() };
      if (operation === "private_file_close") return { closed: true };
      throw new Error("fixture-operation");
    },
  );
  const close = vi.fn(async () => {});
  const transport: ConsumerNativeTransport = { request, close };
  return {
    request,
    close,
    transport,
    native: new WindowsConsumerNative(transport),
    bytes: () => bytes,
    short: (count: number) => {
      shortWrite = count;
    },
    info,
    birth,
  };
}

describe("retained private file capabilities", () => {
  it("uses exact wire policy and keeps native tokens out of the public file port", async () => {
    const f = fixture();
    const file = await f.native.openPrivateFile(
      "prepare\\downloads\\new.part",
      "create-new",
      100,
    );
    expect(f.request).toHaveBeenCalledWith("private_file_open", {
      root: "personal",
      relative_path: "prepare\\downloads\\new.part",
      mode: "create-new",
      maximum_bytes: 100,
      expected_birth: null,
    });
    expect("fd" in file).toBe(false);
    expect("token" in file).toBe(false);
    await file.writeFile("first");
    await file.writeFile("second");
    await file.sync();
    expect(f.bytes().toString()).toBe("firstsecond");
    expect((await file.info()).fileId).toBe("9");
    await file.close();
    await file.close();
    expect(f.close).not.toHaveBeenCalled();
    expect(
      f.request.mock.calls.filter(([op]) => op === "private_file_close"),
    ).toHaveLength(1);
  });
  it("splits large writes, preserves short-write suffixes and serializes append cursors", async () => {
    const f = fixture();
    f.short(13000);
    const file = await f.native.openPrivateFile(
      "scratch\\new.bin",
      "create-new",
      200000,
    );
    const input = Buffer.alloc(PRIVATE_FILE_CHUNK_BYTES * 3 + 5, 73);
    await Promise.all([file.writeFile(input), file.writeFile("tail")]);
    expect(f.bytes()).toEqual(Buffer.concat([input, Buffer.from("tail")]));
    for (const [op, args] of f.request.mock.calls)
      if (op === "private_file_write")
        expect(
          Buffer.from(String(args.bytes_base64), "base64").length,
        ).toBeLessThanOrEqual(PRIVATE_FILE_CHUNK_BYTES);
    await file.close();
  });
  it("supports positional writes without moving the implicit cursor", async () => {
    const f = fixture();
    const file = await f.native.openPrivateFile(
      "scratch\\new.bin",
      "create-new",
      100,
    );
    await file.writeFile("abcd");
    await file.write(Buffer.from("X"), 0, 1, 1);
    await file.writeFile("tail");
    expect(f.bytes().toString()).toBe("aXcdtail");
    await file.truncate(3);
    expect((await file.info()).bytes).toBe(3);
    await file.close();
  });
  it("lets already queued writes finish before consuming close", async () => {
    const f = fixture();
    const file = await f.native.openPrivateFile(
      "scratch\\new.bin",
      "create-new",
      100,
    );
    const write = file.writeFile("queued");
    const close = file.close();
    await write;
    await close;
    expect(f.bytes().toString()).toBe("queued");
    await expect(file.info()).rejects.toMatchObject({
      code: "HELPER_UNAVAILABLE",
    });
  });
  it("reads chunks into the requested slice and returns actual EOF", async () => {
    const data = Buffer.alloc(PRIVATE_FILE_CHUNK_BYTES * 2 + 3, 47),
      f = fixture(data);
    const file = await f.native.openPrivateFile(
      "scratch\\read.bin",
      "read",
      data.length + 100,
    );
    expect(file).not.toBeNull();
    if (!file) throw new Error("fixture-open");
    const target = Buffer.alloc(data.length + 20, 33);
    expect(await file.read(target, 10, data.length + 5, 0)).toEqual({
      bytesRead: data.length,
    });
    expect(target.subarray(10, 10 + data.length)).toEqual(data);
    expect(target[0]).toBe(33);
    expect(await file.read(target, 0, 1, data.length)).toEqual({
      bytesRead: 0,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of file.chunks({ start: 3, end: data.length - 2 }))
      chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(data.subarray(3, -2));
    await file.close();
  });
  it("clamps reads at the retained capacity and accepts EOF at its exact boundary", async () => {
    const f = fixture(Buffer.from("abc"));
    const file = await f.native.openPrivateFile("scratch\\read.bin", "read", 3);
    if (!file) throw new Error("fixture-open");
    const bytes = Buffer.alloc(10);
    expect(await file.read(bytes, 0, 10, 0)).toEqual({ bytesRead: 3 });
    expect(bytes.subarray(0, 3).toString()).toBe("abc");
    expect(await file.read(bytes, 0, 10, 3)).toEqual({ bytesRead: 0 });
    await file.close();
  });
  it("cancels iteration between native reads and retains explicit close authority", async () => {
    const f = fixture(Buffer.alloc(PRIVATE_FILE_CHUNK_BYTES * 3));
    const file = await f.native.openPrivateFile(
      "scratch\\read.bin",
      "read",
      PRIVATE_FILE_MAX_BYTES,
    );
    if (!file) throw new Error("fixture-open");
    const abort = new AbortController();
    const iterator = file
      .chunks({ signal: abort.signal })
      [Symbol.asyncIterator]();
    await iterator.next();
    abort.abort();
    const count = f.request.mock.calls.filter(
      ([op]) => op === "private_file_read",
    ).length;
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(
      f.request.mock.calls.filter(([op]) => op === "private_file_read"),
    ).toHaveLength(count);
    await file.close();
  });
  it("accepts missing only for read with no surplus fields", async () => {
    const f = fixture();
    f.request.mockResolvedValue({ state: "missing" });
    expect(
      await f.native.openPrivateFile("scratch\\missing.bin", "read", 100),
    ).toBeNull();
    expect(f.close).not.toHaveBeenCalled();
    await expect(
      f.native.openPrivateFile("scratch\\missing.bin", "create-new", 100),
    ).rejects.toMatchObject({ code: "PROTOCOL_MISMATCH" });
    f.request.mockResolvedValue({ state: "missing", safe: true });
    await expect(
      f.native.openPrivateFile("scratch\\missing.bin", "read", 100),
    ).rejects.toMatchObject({ code: "PROTOCOL_MISMATCH" });
  });
  it.each([
    { state: "opened", token: "wrong", identity: {} },
    {
      state: "opened",
      token,
      identity: {
        device: "7",
        file_id: "0",
        born_at: "1",
        bytes: 0,
        written_at: "2",
        changed_at: "3",
      },
    },
    {
      state: "opened",
      token,
      identity: {
        device: "7",
        file_id: "9",
        born_at: "1",
        bytes: 0,
        written_at: "2",
        changed_at: "3",
      },
      fd: 123,
    },
  ])("rejects forged or malformed open response %j", async (value) => {
    const f = fixture();
    f.request.mockResolvedValue(value);
    await expect(
      f.native.openPrivateFile("scratch\\new.bin", "create-new", 100),
    ).rejects.toMatchObject({ code: "PROTOCOL_MISMATCH" });
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("awaits helper retirement and poisons existing files after an unusable successful open", async () => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import readline from 'node:readline';
         const reader=readline.createInterface({input:process.stdin});
         reader.on('line',line=>{
           const request=JSON.parse(line);
           process.stdout.write(JSON.stringify({version:1,id:request.id,ok:true,
             result:{state:'opened',token:${JSON.stringify(token)},identity:{
               device:'7',file_id:'9',born_at:'1',
               bytes:request.args.mode==='read'?0:1,written_at:'2',changed_at:'3'
             }}})+'\\n');
         });`,
      ],
      { stdio: ["pipe", "pipe", "pipe"], env: {} },
    );
    let exited = false;
    child.once("close", () => {
      exited = true;
    });
    const transport = new ConsumerNativeChildTransport(child);
    const request = vi.spyOn(transport, "request");
    const teardown = vi.spyOn(transport, "close");
    try {
      const retained = await openConsumerPrivateFile(
        transport,
        "scratch\\existing.bin",
        "read",
        100,
      );
      if (!retained) throw new Error("fixture-open");
      expect(teardown).not.toHaveBeenCalled();
      await expect(
        openConsumerPrivateFile(
          transport,
          "scratch\\new.bin",
          "create-new",
          100,
        ),
      ).rejects.toMatchObject({ code: "PROTOCOL_MISMATCH" });
      expect(exited).toBe(true);
      expect(child.exitCode).toBe(0);
      expect(teardown).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(2);
      expect(request).toHaveBeenLastCalledWith(
        "private_file_open",
        expect.any(Object),
      );
      await expect(retained.info()).rejects.toMatchObject({
        code: "HELPER_UNAVAILABLE",
      });
      expect(request).toHaveBeenCalledTimes(2);
      await expect(transport.request("identity", {})).rejects.toMatchObject({
        code: "HELPER_UNAVAILABLE",
      });
    } finally {
      await transport.close();
    }
  });
  it("retires a successfully opened capability when listener registration fails", async () => {
    const f = fixture();
    const registrationError = new Error("fixture-listener-capacity");
    f.transport.onClosed = () => {
      throw registrationError;
    };
    await expect(
      f.native.openPrivateFile("scratch\\new.bin", "create-new", 100),
    ).rejects.toBe(registrationError);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("waits for teardown after uncertain dispatch failure and never replays the open", async () => {
    const f = fixture();
    const dispatchError = new Error("fixture-uncertain-open");
    f.request.mockRejectedValue(dispatchError);
    let released: (() => void) | undefined;
    f.close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          released = resolve;
        }),
    );
    const rejected = vi.fn();
    const attempt = f.native.openPrivateFile(
      "scratch\\new.bin",
      "create-new",
      100,
    );
    const settled = attempt.catch(rejected);
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledTimes(1));
    expect(rejected).not.toHaveBeenCalled();
    released!();
    await settled;
    expect(rejected).toHaveBeenCalledWith(dispatchError);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it("surfaces rejected teardown without claiming retirement or sending a token close", async () => {
    const f = fixture();
    f.request.mockResolvedValue({ state: "opened", token: "untrusted" });
    const teardownError = new Error("fixture-teardown-unconfirmed");
    f.close.mockRejectedValue(teardownError);
    await expect(
      f.native.openPrivateFile("scratch\\new.bin", "create-new", 100),
    ).rejects.toBe(teardownError);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(
      f.request.mock.calls.some(([op]) => op === "private_file_close"),
    ).toBe(false);
  });
  it("requires exact trusted resume birth and never truncates during open", async () => {
    const f = fixture(Buffer.from("partial"));
    await expect(
      openConsumerPrivateFile(f.transport, "scratch\\new.bin", "resume", 100, {
        device: "7",
        fileId: "9",
        bornAt: f.birth.born_at,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const file = await f.native.openPrivateFile(
      "prepare\\downloads\\runtime.part",
      "resume",
      100,
      { device: "7", fileId: "9", bornAt: f.birth.born_at },
    );
    expect(f.bytes().toString()).toBe("partial");
    expect(
      f.request.mock.calls.some(([op]) => op === "private_file_truncate"),
    ).toBe(false);
    await file.close();
  });
  it("compares resumed identity against the dispatched trusted birth snapshot", async () => {
    const f = fixture(Buffer.from("partial"));
    const expected = { device: "7", fileId: "9", bornAt: f.birth.born_at };
    let opened: ((value: unknown) => void) | undefined;
    f.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          opened = resolve;
        }),
    );
    const attempt = f.native.openPrivateFile(
      "prepare\\downloads\\runtime.part",
      "resume",
      100,
      expected,
    );
    expect(f.request).toHaveBeenCalledWith(
      "private_file_open",
      expect.objectContaining({
        expected_birth: { device: "7", file_id: "9", born_at: f.birth.born_at },
      }),
    );
    expected.fileId = "10";
    opened!({ state: "opened", token, identity: f.info() });
    const file = await attempt;
    expect((await file.info()).fileId).toBe("9");
    expect(f.close).not.toHaveBeenCalled();
    await file.close();
  });
  it("rejects changed birth, malformed base64/counts and never replays uncertain writes", async () => {
    const f = fixture();
    const file = await f.native.openPrivateFile(
      "scratch\\new.bin",
      "create-new",
      100,
    );
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (op, args) =>
      op === "private_file_write" ? { bytes_written: 0 } : original(op, args),
    );
    await expect(file.writeFile("payload")).rejects.toMatchObject({
      code: "PROTOCOL_MISMATCH",
    });
    await expect(file.writeFile("again")).rejects.toMatchObject({
      code: "HELPER_UNAVAILABLE",
    });
    expect(
      f.request.mock.calls.filter(([op]) => op === "private_file_write"),
    ).toHaveLength(1);
    await file.close();
    const readFixture = fixture(Buffer.from("abc"));
    const read = await readFixture.native.openPrivateFile(
      "scratch\\read.bin",
      "read",
      100,
    );
    if (!read) throw new Error("fixture-open");
    readFixture.request.mockResolvedValue({
      bytes_base64: "YQ",
      bytes_read: 1,
    });
    await expect(read.read(Buffer.alloc(3), 0, 3, 0)).rejects.toMatchObject({
      code: "PROTOCOL_MISMATCH",
    });
    readFixture.request.mockResolvedValue({ closed: true });
    await read.close();
    const birthFixture = fixture();
    const born = await birthFixture.native.openPrivateFile(
      "scratch\\new.bin",
      "create-new",
      100,
    );
    birthFixture.request.mockResolvedValue({
      identity: { ...birthFixture.info(), file_id: "10" },
    });
    await expect(born.info()).rejects.toMatchObject({
      code: "PROTOCOL_MISMATCH",
    });
    birthFixture.request.mockResolvedValue({ closed: true });
    await born.close();
  });
  it("retains a failed close result without replay or false successful release", async () => {
    const f = fixture();
    const file = await f.native.openPrivateFile(
      "scratch\\new.bin",
      "create-new",
      100,
    );
    f.request.mockResolvedValue({ closed: false });
    await expect(file.close()).rejects.toMatchObject({
      code: "PROTOCOL_MISMATCH",
    });
    await expect(file.close()).rejects.toMatchObject({
      code: "PROTOCOL_MISMATCH",
    });
    expect(
      f.request.mock.calls.filter(([op]) => op === "private_file_close"),
    ).toHaveLength(1);
  });
  it("validates bounds and forbids mutating read mode before dispatch", async () => {
    const f = fixture(Buffer.from("x"));
    const file = await openConsumerPrivateFile(
      f.transport,
      "scratch\\read.bin",
      "read",
      100,
    );
    if (!file) throw new Error("fixture-open");
    expect(() => file.writeFile("x")).toThrow();
    expect(() => file.truncate(0)).toThrow();
    expect(() => file.read(Buffer.alloc(2), 0, 2, -1)).toThrow();
    expect(f.request.mock.calls).toHaveLength(1);
    await file.close();
    await expect(
      f.native.openPrivateFile("..\\unsafe", "read", 100),
    ).rejects.toMatchObject({ code: "PATH_UNSAFE" });
    await expect(
      f.native.openPrivateFile("safe.bin", "read", PRIVATE_FILE_MAX_BYTES + 1),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      f.native.openPrivateFile("safe.bin", "read", 0),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      f.native.openPrivateFile(Array(33).fill("deep").join("\\"), "read", 100),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(f.close).not.toHaveBeenCalled();
  });
  it("uses the dedicated Store fixture data operation with the original bounded file capability (synthetic transport)", async () => {
    const f = fixture(),
      relative = `prepare\\approved\\${"b".repeat(64)}.wav`,
      file = await f.native.openStoreFixtureFile(relative, 44);
    expect(f.request.mock.calls[0]).toEqual([
      "store_fixture_file_open",
      {
        root: "personal",
        relative_path: relative,
        mode: "create-new",
        maximum_bytes: 44,
        expected_birth: null,
      },
    ]);
    await file.writeFile(Buffer.alloc(44));
    await file.sync();
    await file.close();
    expect(f.bytes()).toHaveLength(44);
    const resumed = fixture(Buffer.alloc(44)),
      original = { device: "7", fileId: "9", bornAt: "1700000000000000000" },
      writer = await resumed.native.openStoreFixtureFile(
        relative,
        44,
        original,
      );
    expect(resumed.request.mock.calls[0]?.[1]).toMatchObject({
      mode: "resume",
      expected_birth: {
        device: original.device,
        file_id: original.fileId,
        born_at: original.bornAt,
      },
    });
    expect(resumed.request.mock.calls).toHaveLength(1);
    await writer.close();
  });
  it("rejects alternate fixture paths/bounds and preserves the legacy resume whitelist before dispatch", async () => {
    const f = fixture(),
      relative = `prepare\\approved\\${"b".repeat(64)}.wav`,
      birth = { device: "7", fileId: "9", bornAt: "1700000000000000000" };
    for (const path of [
      relative.toUpperCase(),
      relative + ".part",
      "models\\Kim_Vocal_2.onnx",
      "prepare\\approved\\..\\input.wav",
      "C:\\input.wav",
    ])
      await expect(
        f.native.openStoreFixtureFile(path, 44),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    for (const maximum of [0, 43, 64 * 1024 ** 2 + 1, NaN, 44.5])
      await expect(
        f.native.openStoreFixtureFile(relative, maximum),
      ).rejects.toThrow();
    await expect(
      f.native.openPrivateFile(relative, "resume", 44, birth),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(f.request).not.toHaveBeenCalled();
    await expect(
      f.native.openStoreFixtureFile(relative, 44, { ...birth, fileId: "10" }),
    ).rejects.toMatchObject({ code: "PROTOCOL_MISMATCH" });
    expect(f.close).toHaveBeenCalledOnce();
  });
});
