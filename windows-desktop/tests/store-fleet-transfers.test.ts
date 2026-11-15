import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostContext } from "../src/main/host-context.js";
import type { StoreNodeIssuer } from "../src/main/session/store-node-issuer.js";
import {
  TransferError,
  TransferOwnershipError,
} from "../../worker/src/runtime/transfers.js";

// Explicit synthetic private module boundary. These fixtures model lifecycle
// decisions only; no actual Creator, Store code, directory, transfer or Job exists.
const boundary = vi.hoisted(() => {
  const state = { create: vi.fn(), views: vi.fn(), events: [] as string[] };
  class Issuer {
    #native: object;
    #role: string;
    #owner: object;
    inventorySha256 = "a".repeat(64);
    constructor(native: object, role: string, owner: object) {
      this.#native = native;
      this.#role = role;
      this.#owner = owner;
    }
    get nodeRole() {
      return this.#role;
    }
    get owner() {
      return this.#owner;
    }
    assertNative(native: object) {
      if (native !== this.#native) throw Error("WRONG_NATIVE");
    }
    async codeView() {
      return state.views();
    }
    async createFleetTransfer(request: object) {
      return state.create(this, request);
    }
  }
  class Child {
    #issuer: Issuer;
    #closed = false;
    #stop?: Promise<void>;
    #stdout: Readable;
    #plan: any;
    constructor(issuer: Issuer, plan: any) {
      this.#issuer = issuer;
      this.#plan = plan;
      this.#stdout = new Readable({ read() {} });
      this.#stdout.on("error", () => {});
    }
    get stdout() {
      return this.#stdout;
    }
    closedForIssuer(issuer: Issuer) {
      if (issuer !== this.#issuer) throw Error("WRONG_CHILD_ISSUER");
      return this.#closed;
    }
    async start() {
      state.events.push("start");
      if (this.#plan.start) await this.#plan.start.promise;
      if (this.#closed) throw Error("ORIGINAL_STOPPED");
      if (this.#plan.startError) throw this.#plan.startError;
    }
    async write(bytes: Uint8Array) {
      state.events.push("write");
      this.#plan.request = JSON.parse(Buffer.from(bytes).toString());
      this.#plan.bytes = Buffer.from(bytes);
      if (this.#plan.writeError) throw this.#plan.writeError;
      if (this.#plan.output !== false) {
        const request = this.#plan.request;
        const reply = this.#plan.reply ?? {
          version: 1,
          requestId: request.requestId,
          ok: true,
          result: request.operation === "download" ? null : '"original-etag"',
        };
        this.#stdout.push(
          typeof reply === "string"
            ? Buffer.from(reply)
            : Buffer.from(
                JSON.stringify({
                  ...reply,
                  requestId: reply.requestId ?? request.requestId,
                }) + "\n",
              ),
        );
        this.#stdout.push(null);
      }
    }
    async waitForExit() {
      state.events.push("wait");
      if (this.#plan.exit) await this.#plan.exit.promise;
      if (this.#plan.exitError) throw this.#plan.exitError;
      return this.#plan.exitCode ?? 0;
    }
    stop() {
      state.events.push("stop-call");
      return (this.#stop ??= this.#retire(false));
    }
    async recoverStop() {
      state.events.push("recover-call");
      if (!this.#stop) throw Error("NO_ORIGINAL_STOP");
      await this.#stop.catch(() => {});
      this.#stop = this.#retire(true);
      return this.#stop;
    }
    async #retire(recovery: boolean) {
      state.events.push(recovery ? "recover-original" : "stop-original");
      if (this.#plan.stop) await this.#plan.stop.promise;
      if (recovery ? this.#plan.recoverError : this.#plan.stopError)
        throw recovery ? this.#plan.recoverError : this.#plan.stopError;
      this.#plan.start?.resolve();
      this.#plan.exit?.resolve();
      if (!this.#stdout.readableEnded)
        this.#stdout.destroy(Error("ORIGINAL_STOPPED"));
      if (this.#plan.closedOnStop !== false) this.#closed = true;
      state.events.push("closed");
    }
  }
  return { state, Issuer, Child };
});
vi.mock("../src/main/session/store-node-issuer.js", () => ({
  StoreNodeIssuer: boundary.Issuer,
  StoreFleetTransferChild: boundary.Child,
}));
import { StoreFleetTransfers } from "../src/main/fleet/store-transfers.js";
function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (value: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const attemptId = "87654321-1234-4234-9234-123456789012",
  localAppData = "C:\\Users\\Fixture\\AppData\\Local",
  root = `${localAppData}\\MusicMuteWorker\\work\\${attemptId}`;
const identity = {
  sid: "S-1-5-21-1-2-3-1001",
  sessionId: 1,
  pid: 23,
  creationTime: "133900000000000000",
  localAppData,
  logonSid: "S-1-5-5-1-2",
  nativeArch: "x64",
  processArch: "x64",
  osMajor: 10,
  osBuild: 19045,
};
const binding = {
  sid: identity.sid,
  inventorySha256: "a".repeat(64),
  runtimeManifestSha256: "b".repeat(64),
  bootIdentity: "c".repeat(64),
  package: { fullName: "synthetic-worker" },
  recipeDigests: {},
};
const sha256 = createHash("sha256").update("fixture").digest("base64"),
  expected = {
    key: "input.mp3",
    etag: '"input-etag"',
    bytes: 7,
    sha256,
    contentType: "audio/mpeg",
  },
  grant = {
    url: "https://fixture.r2.cloudflarestorage.com/input?signature=PRIVATE",
    expiresAt: "2027-01-01T00:00:00.000Z",
  };
function setup(plan: any = {}) {
  const native = {
      identity: vi.fn(async () => ({ ...identity })),
      bootIdentity: vi.fn(async () => binding.bootIdentity),
    },
    host = {
      native,
      identity: { ...identity },
      personalRoot: `${localAppData}\\MusicMuteLocal`,
    } as unknown as HostContext;
  const actor = new boundary.Issuer(native, "fleet", {
      role: "fleet",
      nonce: "d".repeat(64),
      identity: {
        sid: identity.sid,
        sessionId: identity.sessionId,
        pid: 111,
        creationTime: "133900000000000001",
      },
    }),
    issuer = actor as unknown as StoreNodeIssuer;
  const child = new boundary.Child(actor, plan);
  boundary.state.views.mockResolvedValue({
    binding: structuredClone(binding),
    manifest: {},
  });
  boundary.state.create.mockResolvedValue(child);
  return {
    native,
    host,
    issuer,
    actor,
    child,
    plan,
    open: () => StoreFleetTransfers.open(host, issuer),
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  boundary.state.create.mockReset();
  boundary.state.views.mockReset();
  boundary.state.events.length = 0;
});
const turns = () => new Promise<void>((done) => setImmediate(done));
const uploadGrant = () => ({
  url: grant.url,
  expiresAt: grant.expiresAt,
  method: "PUT" as const,
  headers: {
    "Content-Type": "audio/mpeg",
    "If-None-Match": "*",
    "x-amz-checksum-sha256": sha256,
    "x-amz-meta-sha256": sha256,
  },
});

describe("real-boundary Store Fleet transfer lifetime decisions", () => {
  it("requires actual issuer role/native/code generation and rejects lookalikes before IO", async () => {
    const f = setup();
    await expect(
      StoreFleetTransfers.open(f.host, {} as StoreNodeIssuer),
    ).rejects.toThrow();
    expect(f.native.identity).not.toHaveBeenCalled();
    await expect(
      StoreFleetTransfers.open(
        f.host,
        new boundary.Issuer(
          f.native,
          "personal",
          {},
        ) as unknown as StoreNodeIssuer,
      ),
    ).rejects.toThrow();
    expect(f.native.identity).not.toHaveBeenCalled();
    await expect(
      StoreFleetTransfers.open(
        { ...f.host, native: { ...f.native } } as unknown as HostContext,
        f.issuer,
      ),
    ).rejects.toThrow();
    boundary.state.views.mockResolvedValue({
      binding: { ...binding, inventorySha256: "e".repeat(64) },
      manifest: {},
    });
    await expect(f.open()).rejects.toThrow();
    expect(boundary.state.create).not.toHaveBeenCalled();
  });
  it("derives work only from fresh native LocalAppData and refuses foreign original SID/session", async () => {
    const f = setup();
    f.native.identity.mockResolvedValue({
      ...identity,
      localAppData: "D:\\foreign",
    });
    await expect(f.open()).rejects.toThrow();
    f.native.identity.mockResolvedValue({ ...identity, sessionId: 2 });
    await expect(f.open()).rejects.toThrow();
    f.native.identity.mockResolvedValue({
      ...identity,
      sid: "S-1-5-21-9-8-7-1001",
    });
    await expect(f.open()).rejects.toThrow();
    expect(boundary.state.create).not.toHaveBeenCalled();
  });
  it("returns download only after original exit, both-EOF child contract and positive original stop", async () => {
    const f = setup({ exit: deferred(), stop: deferred() }),
      client = await f.open();
    let finished = false;
    const task = client
      .download(grant, expected, `${root}\\input.mp3`)
      .then(() => {
        finished = true;
      });
    await vi.waitFor(() => expect(boundary.state.events).toContain("wait"));
    expect(finished).toBe(false);
    f.plan.exit.resolve();
    await vi.waitFor(() =>
      expect(boundary.state.events).toContain("stop-original"),
    );
    expect(finished).toBe(false);
    f.plan.stop.resolve();
    await task;
    expect(finished).toBe(true);
    expect(
      boundary.state.events.filter((x) => x === "stop-original"),
    ).toHaveLength(1);
    expect(boundary.state.create).toHaveBeenCalledExactlyOnceWith(f.actor, {
      requestId: f.plan.request.requestId,
      operation: "download",
      attemptId,
      relativePath: `work\\${attemptId}\\input.mp3`,
    });
    expect(f.plan.request.options).toEqual({});
    expect(f.plan.request.workspace).toBe(root);
    expect(f.plan.bytes.at(-1)).toBe(10);
    await client.close();
  });
  it("returns the exact quoted upload ETag after original cleanup", async () => {
    const f = setup(),
      client = await f.open();
    expect(
      await client.upload(uploadGrant(), `${root}\\output\\vocals.mp3`, {
        bytes: 7,
        sha256,
        contentType: "audio/mpeg",
      }),
    ).toBe('"original-etag"');
    expect(boundary.state.events.indexOf("closed")).toBeGreaterThan(
      boundary.state.events.indexOf("wait"),
    );
    expect(f.plan.request.grant.headers).toEqual(uploadGrant().headers);
    await client.close();
  });
  it("fresh-grant upload retry uses a new operation UUID only after the previous original child is positively closed", async () => {
    const f = setup(),
      client = await f.open(),
      children: InstanceType<typeof boundary.Child>[] = [],
      plans: any[] = [];
    boundary.state.create.mockImplementation((actor, tuple) => {
      if (children.length)
        expect(children.at(-1)!.closedForIssuer(actor)).toBe(true);
      const plan = children.length
        ? {}
        : {
            reply: {
              version: 1,
              ok: false,
              retryable: true,
              diagnostic: "transfer-grant-expired",
            },
          };
      const child = new boundary.Child(actor, plan);
      children.push(child);
      plans.push(plan);
      expect(Object.isFrozen(tuple)).toBe(true);
      return child;
    });
    await expect(
      client.upload(uploadGrant(), `${root}\\output\\vocals.mp3`, {
        bytes: 7,
        sha256,
        contentType: "audio/mpeg",
      }),
    ).rejects.toMatchObject({
      retryable: true,
      diagnostic: "transfer-grant-expired",
    });
    const fresh = {
      ...uploadGrant(),
      url: "https://fixture.r2.cloudflarestorage.com/output?signature=FRESH",
    };
    expect(
      await client.upload(fresh, `${root}\\output\\vocals.mp3`, {
        bytes: 7,
        sha256,
        contentType: "audio/mpeg",
      }),
    ).toBe('"original-etag"');
    const first = boundary.state.create.mock.calls[0]![1],
      second = boundary.state.create.mock.calls[1]![1];
    expect(first.requestId).not.toBe(second.requestId);
    expect(first.attemptId).toBe(second.attemptId);
    expect(first.relativePath).toBe(second.relativePath);
    expect(plans[0].request.requestId).toBe(first.requestId);
    expect(plans[1].request.requestId).toBe(second.requestId);
    expect(plans[1].request.grant.url).toBe(fresh.url);
    expect(children[0]).not.toBe(children[1]);
    await client.close();
  });
  it.each(["startError", "writeError", "exitError"])(
    "retains safe failure and original cleanup after %s",
    async (stage) => {
      const f = setup({ [stage]: Error("original private failure") }),
        client = await f.open();
      await expect(
        client.download(grant, expected, `${root}\\input.mp3`),
      ).rejects.toMatchObject({
        code: "DOWNLOAD_FAILED",
        diagnostic: "transfer-process-failed",
      });
      expect(boundary.state.events).toContain("closed");
      expect(
        boundary.state.events.filter((value) => value === "stop-original"),
      ).toHaveLength(1);
      await client.close();
    },
  );
  it("a correlated success reply cannot override the actual nonzero child exit", async () => {
    const f = setup({ exitCode: 2 }),
      client = await f.open();
    await expect(
      client.download(grant, expected, `${root}\\input.mp3`),
    ).rejects.toMatchObject({
      diagnostic: "transfer-process-failed",
      retryable: true,
    });
    expect(boundary.state.events).toContain("closed");
    await client.close();
  });
  it("close still joins the original task during final code validation after child cleanup", async () => {
    const f = setup(),
      client = await f.open(),
      finalCode = deferred();
    let checking = false;
    boundary.state.views.mockImplementation(async () => {
      if (boundary.state.events.includes("closed")) {
        checking = true;
        await finalCode.promise;
      }
      return { binding: structuredClone(binding), manifest: {} };
    });
    const task = client.download(grant, expected, `${root}\\input.mp3`);
    void task.catch(() => {});
    await vi.waitFor(() => expect(checking).toBe(true));
    let closed = false;
    const closing = client.close();
    void closing.then(() => {
      closed = true;
    });
    await turns();
    expect(closed).toBe(false);
    finalCode.resolve();
    await closing;
    await expect(task).rejects.toBeInstanceOf(TransferError);
    expect(
      boundary.state.events.filter((value) => value === "stop-original"),
    ).toHaveLength(1);
  });
  it("a reentrant close joins the task reserved before its first native call and launches no child", async () => {
    const f = setup(),
      client = await f.open();
    let closing: Promise<void> | undefined;
    f.native.identity.mockImplementation(async () => {
      closing ??= client.close();
      return { ...identity };
    });
    await expect(
      client.download(grant, expected, `${root}\\input.mp3`),
    ).rejects.toBeInstanceOf(TransferError);
    expect(closing).toBeDefined();
    await closing;
    expect(boundary.state.create).not.toHaveBeenCalled();
    expect(boundary.state.events).toEqual([]);
  });
  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])(
    "close joins the exact accepted public promise at final handoff microtask %s",
    async (depth) => {
      const f = setup(),
        client = await f.open();
      let scheduled = false,
        settled = false,
        joining: Promise<void> | undefined;
      const later = (remaining: number) =>
        queueMicrotask(() => {
          if (remaining) later(remaining - 1);
          else
            joining = client.close().then(() => {
              expect(settled).toBe(true);
            });
        });
      boundary.state.views.mockImplementation(async () => {
        if (boundary.state.events.includes("closed") && !scheduled) {
          scheduled = true;
          later(depth);
        }
        return { binding: structuredClone(binding), manifest: {} };
      });
      const original = client.download(grant, expected, `${root}\\input.mp3`);
      void original.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await original.catch(() => {});
      await vi.waitFor(() => expect(joining).toBeDefined());
      await joining;
      expect(
        boundary.state.events.filter((value) => value === "stop-original"),
      ).toHaveLength(1);
    },
  );
  it("copies caller request/grant/identity before an async authority check", async () => {
    const f = setup(),
      client = await f.open(),
      gate = deferred();
    f.native.identity.mockImplementation(async () => {
      await gate.promise;
      return { ...identity };
    });
    const g = { ...grant },
      e = { ...expected },
      task = client.download(g, e, `${root}\\input.mp3`);
    g.url = "https://foreign.invalid";
    e.bytes = 900;
    gate.resolve();
    await task;
    expect(f.plan.request.grant.url).toBe(grant.url);
    expect(f.plan.request.expected.bytes).toBe(7);
    await client.close();
  });
  it.each([
    "../input.mp3",
    "input.wav",
    "input.mp3:stream",
    "output/vocals.mp3",
  ])(
    "rejects escaped/mismatched download path %s before native creation",
    async (part) => {
      const f = setup(),
        client = await f.open();
      await expect(
        client.download(grant, expected, `${root}\\${part}`),
      ).rejects.toThrow();
      expect(boundary.state.create).not.toHaveBeenCalled();
      await client.close();
    },
  );
  it("does not invoke caller grant getters or a second live same-attempt factory", async () => {
    const f = setup({ exit: deferred() }),
      client = await f.open(),
      getter = vi.fn();
    const bad = { ...grant };
    Object.defineProperty(bad, "url", { enumerable: true, get: getter });
    await expect(
      client.download(bad, expected, `${root}\\input.mp3`),
    ).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
    const task = client.download(grant, expected, `${root}\\input.mp3`);
    await vi.waitFor(() => expect(boundary.state.events).toContain("wait"));
    await expect(
      client.download(grant, expected, `${root}\\input.mp3`),
    ).rejects.toBeInstanceOf(TransferOwnershipError);
    expect(boundary.state.create).toHaveBeenCalledTimes(1);
    f.plan.exit.resolve();
    await task;
    await client.close();
  });
  it.each(["invalid-json", "overflow", "wrong-request", "two-lines"])(
    "joins original child after %s reply",
    async (kind) => {
      const plan: any = {
        reply:
          kind === "overflow"
            ? "x".repeat(2049)
            : kind === "two-lines"
              ? "{}\n{}\n"
              : kind === "wrong-request"
                ? { version: 1, requestId: attemptId, ok: true, result: null }
                : "broken\n",
      };
      const f = setup(plan),
        client = await f.open();
      await expect(
        client.download(grant, expected, `${root}\\input.mp3`),
      ).rejects.toBeInstanceOf(TransferError);
      expect(boundary.state.events).toContain("closed");
      await client.close();
    },
  );
  it("retains safe correlated operation failure after positive original closure", async () => {
    const f = setup({
        reply: {
          version: 1,
          ok: false,
          retryable: false,
          diagnostic: "transfer-integrity-failed",
        },
      }),
      client = await f.open();
    await expect(
      client.download(grant, expected, `${root}\\input.mp3`),
    ).rejects.toMatchObject({
      code: "DOWNLOAD_FAILED",
      retryable: false,
      diagnostic: "transfer-integrity-failed",
    });
    expect(boundary.state.events).toContain("closed");
    await client.close();
  });
  it("stops and joins the original child on cancellation during start without writing grants", async () => {
    const f = setup({ start: deferred() }),
      client = await f.open(),
      controller = new AbortController(),
      reason = Error("cancelled");
    const task = client.download(
      grant,
      expected,
      `${root}\\input.mp3`,
      controller.signal,
    );
    void task.catch(() => {});
    await vi.waitFor(() => expect(boundary.state.events).toContain("start"));
    controller.abort(reason);
    await expect(task).rejects.toBe(reason);
    expect(boundary.state.events).toContain("closed");
    expect(boundary.state.events).not.toContain("write");
    await client.close();
  });
  it("uses the unchanged two-hour timeout and retires the original timed-out child", async () => {
    const timer = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timer.signal);
    const f = setup({ output: false, exit: deferred() }),
      client = await f.open(),
      task = client.download(grant, expected, `${root}\\input.mp3`);
    void task.catch(() => {});
    await vi.waitFor(() => expect(boundary.state.events).toContain("wait"));
    expect(AbortSignal.timeout).toHaveBeenCalledWith(7_200_000);
    timer.abort();
    await expect(task).rejects.toMatchObject({
      diagnostic: "transfer-process-timeout",
    });
    expect(boundary.state.events).toContain("closed");
    await client.close();
  });
  it("retains failed exact stop and requires explicit recovery of the same child", async () => {
    const original = Error("original private close failed"),
      f = setup({ stopError: original }),
      client = await f.open(),
      task = client.download(grant, expected, `${root}\\input.mp3`);
    await expect(task).rejects.toBeInstanceOf(TransferOwnershipError);
    await expect(client.close()).rejects.toThrow(
      "STORE_TRANSFER_CLEANUP_PENDING",
    );
    await expect(
      client.download(grant, expected, `${root}\\input.mp3`),
    ).rejects.toMatchObject({ diagnostic: "transfer-process-closed" });
    f.plan.stopError = undefined;
    const a = client.recoverClose(),
      b = client.recoverClose();
    expect(a).toBe(b);
    await a;
    expect(boundary.state.create).toHaveBeenCalledTimes(1);
    expect(
      boundary.state.events.filter((x) => x === "recover-original"),
    ).toHaveLength(1);
    await client.close();
  });
  it("cannot infer positive cleanup from a resolved stop callback with a still-open original owner", async () => {
    const f = setup({ closedOnStop: false }),
      client = await f.open();
    await expect(
      client.download(grant, expected, `${root}\\input.mp3`),
    ).rejects.toBeInstanceOf(TransferOwnershipError);
    await expect(client.close()).rejects.toThrow();
    f.plan.closedOnStop = true;
    await client.recoverClose();
    expect(boundary.state.events).toContain("recover-original");
  });
  it("keeps a failed explicit recovery blocked until a later retry joins the same original child", async () => {
    const f = setup({
        stopError: Error("first close"),
        recoverError: Error("retry close"),
      }),
      client = await f.open();
    await expect(
      client.download(grant, expected, `${root}\\input.mp3`),
    ).rejects.toBeInstanceOf(TransferOwnershipError);
    await expect(client.close()).rejects.toThrow();
    await expect(client.recoverClose()).rejects.toThrow(
      "STORE_TRANSFER_CLEANUP_PENDING",
    );
    expect(boundary.state.create).toHaveBeenCalledTimes(1);
    f.plan.stopError = undefined;
    f.plan.recoverError = undefined;
    await client.recoverClose();
    expect(
      boundary.state.events.filter((value) => value === "recover-original"),
    ).toHaveLength(2);
    expect(boundary.state.create).toHaveBeenCalledTimes(1);
  });
  it("retains an uncertain construction and recovers only the same frozen original factory tuple", async () => {
    const f = setup(),
      client = await f.open(),
      failure = Error("original factory ack lost");
    boundary.state.create
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(f.child);
    await expect(
      client.download(grant, expected, `${root}\\input.mp3`),
    ).rejects.toBeInstanceOf(TransferOwnershipError);
    await expect(client.close()).rejects.toThrow();
    await client.recoverClose();
    expect(boundary.state.create).toHaveBeenCalledTimes(2);
    expect(boundary.state.create.mock.calls[0]![1]).toBe(
      boundary.state.create.mock.calls[1]![1],
    );
    expect(boundary.state.events).not.toContain("start");
    expect(boundary.state.events).toContain("closed");
  });
  it("a wrong child owner authorizes no start/write/stop effects", async () => {
    const f = setup(),
      client = await f.open(),
      foreign = new boundary.Issuer(f.native, "fleet", {});
    boundary.state.create.mockResolvedValue(new boundary.Child(foreign, {}));
    await expect(
      client.download(grant, expected, `${root}\\input.mp3`),
    ).rejects.toBeInstanceOf(TransferOwnershipError);
    expect(boundary.state.events).toEqual([]);
    await expect(client.close()).rejects.toThrow();
  });
  it("concurrent close joins original construction/task and never repeats its original stop", async () => {
    const f = setup({ stop: deferred() }),
      client = await f.open(),
      factory = deferred<InstanceType<typeof boundary.Child>>();
    boundary.state.create.mockReturnValue(factory.promise);
    const task = client.download(grant, expected, `${root}\\input.mp3`);
    void task.catch(() => {});
    await vi.waitFor(() =>
      expect(boundary.state.create).toHaveBeenCalledTimes(1),
    );
    let closed = false;
    const a = client.close(),
      b = client.close();
    expect(a).toBe(b);
    void a.then(() => {
      closed = true;
    });
    await turns();
    expect(closed).toBe(false);
    factory.resolve(f.child);
    await vi.waitFor(() =>
      expect(boundary.state.events).toContain("stop-original"),
    );
    expect(closed).toBe(false);
    f.plan.stop.resolve();
    await a;
    await expect(task).rejects.toBeInstanceOf(TransferError);
    expect(
      boundary.state.events.filter((x) => x === "stop-original"),
    ).toHaveLength(1);
    expect(boundary.state.events).not.toContain("start");
  });
});
