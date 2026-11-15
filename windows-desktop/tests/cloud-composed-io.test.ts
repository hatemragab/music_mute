import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Translate fixed Windows paths only for this temporary-filesystem code fixture.
vi.mock("node:path", async (original) => {
  const actual = await original<typeof import("node:path")>();
  return {
    ...actual,
    win32: {
      ...actual.win32,
      join: (...parts: string[]) =>
        actual.join(...parts.map((part) => part.replaceAll("\\", "/"))),
    },
  };
});
const nativeCodec = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../src/main/prepare/owned-media-operation.js", async (original) => ({
  ...(await original<
    typeof import("../src/main/prepare/owned-media-operation.js")
  >()),
  runOwnedMediaOperation: nativeCodec.run,
}));

import type { runOwnedMediaOperation } from "../src/main/prepare/owned-media-operation.js";
import type {
  CloudMediaChildConfig,
  CloudMediaChildResult,
} from "../src/main/cloud/media-child.js";
import { libraryNamespace } from "../src/main/library/store.js";
import {
  cloudComposedIoFixture,
  deferred,
  type ComposedCloudSocket,
} from "./cloud-composed-io-fixture.js";

type Fixture = Awaited<ReturnType<typeof cloudComposedIoFixture>>;
type CodecOptions = Parameters<
  typeof runOwnedMediaOperation<CloudMediaChildConfig, CloudMediaChildResult>
>[0];
const fixtures: Fixture[] = [];
const releaseHeldIo: (() => void)[] = [];
afterEach(async () => {
  for (const release of releaseHeldIo.splice(0)) release();
  // Stop real controller timers/watchers and close borrowed handles before removing only fixture bytes.
  for (const fixture of fixtures.splice(0)) {
    await fixture.dispose();
    await rm(fixture.root, { recursive: true, force: true });
  }
  nativeCodec.run.mockReset();
  vi.unstubAllGlobals();
});

async function fixture() {
  // A forgotten injected destination fails immediately instead of reaching the network.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Live network is forbidden in this fixture");
    }),
  );
  const f = await cloudComposedIoFixture();
  fixtures.push(f);
  nativeCodec.run.mockImplementation(async (options: CodecOptions) => {
    options.signal.throwIfAborted();
    await options.beforeLaunch?.();
    await options.onOwner?.({
      role: "prepare",
      nonce: "a".repeat(64),
      identity: f.parent,
    });
    const config = options.configuration(await f.tools.snapshotMediaTools()),
      bytes = config.operation === "cloud_prepare" ? f.prepared : f.voice;
    if (config.operation === "cloud_prepare")
      await writeFile(
        join(f.root, "cloud", "work", config.requestId, "source.m4a"),
        bytes,
      );
    // Exact native process ownership/exit and codec observations are injected, never executed on the Mac.
    f.setExited(true);
    return options.parse(
      {
        version: 1,
        operation: config.operation,
        requestId: config.requestId,
        executionId: config.executionId,
        source: "audio_file",
        bytes: bytes.length,
        durationSeconds: 60,
        sha256: f.hash(bytes),
        codec: config.operation === "cloud_prepare" ? "aac" : "mp3",
      },
      config,
    );
  });
  return f;
}

async function start(
  f: Fixture,
  socket: ComposedCloudSocket,
  kind: "url" | "file" = "url",
) {
  await f.cloud.setMode("cloud");
  const selected =
      kind === "file" ? await f.files.grant(f.source, "composed-window") : null,
    confirmation =
      kind === "url"
        ? f.cloud.prepareYouTubeConfirmation({
            videoId: f.videoId,
            durationSeconds: 60,
            title: "Composed fixture voice",
          })
        : f.cloud.prepareFileConfirmation({
            fileCapability: selected!.capability,
            name: selected!.name,
            bytes: selected!.bytes,
          });
  expect(
    f.calls.filter((call) =>
      ["/jobs", "/media-imports"].includes(call.url.pathname),
    ),
  ).toEqual([]);
  const pending = f.cloud.confirm(confirmation.capability, true);
  if (kind === "url") {
    await vi.waitFor(() =>
      expect(socket.subscription("import", f.importId)).toBeDefined(),
    );
    socket.snapshot(
      "import",
      {
        import_id: f.importId,
        status: "downloading",
        job_id: null,
        error: null,
      },
      f.importId,
    );
    expect(f.cloud.view().phase).toBe("importing");
    socket.snapshot(
      "import",
      {
        import_id: f.importId,
        status: "submitted",
        job_id: f.jobId,
        error: null,
      },
      f.importId,
    );
  }
  await vi.waitFor(() =>
    expect(socket.subscription("job", f.jobId)).toBeDefined(),
  );
  socket.snapshot("job", f.job("queued"), f.jobId);
  socket.snapshot("job", f.job("processing"), f.jobId);
  expect(f.cloud.view()).toMatchObject({
    phase: "processing",
    busy: true,
    job: { id: f.jobId },
  });
  return { pending, confirmation };
}

function expectCommandOnlyBackend(f: Fixture, owners = 1) {
  const api = f.calls.filter(
    (call) => call.url.origin === "https://api.example.test",
  );
  expect(api.every((call) => call.init.method === "POST")).toBe(true);
  expect(
    api.filter((call) => call.url.pathname === "/realtime-tickets"),
  ).toHaveLength(owners);
  expect(
    api.filter((call) =>
      ["/jobs", "/media-imports"].includes(call.url.pathname),
    ),
  ).toHaveLength(1);
  expect(
    api.filter((call) => call.url.pathname.endsWith("/download-grants")),
  ).toHaveLength(1);
  expect(
    f.calls
      .filter((call) => call.url.hostname.endsWith(".r2.cloudflarestorage.com"))
      .every((call) => !new Headers(call.init.headers).has("Authorization")),
  ).toBe(true);
  expect(f.sockets).toHaveLength(owners);
}

function preparedCleanup(f: Fixture) {
  const entered = deferred<void>(),
    release = deferred<void>(),
    original = f.pins.pinTree.bind(f.pins);
  let deny = false;
  releaseHeldIo.push(() => {
    deny = false;
    release.resolve();
  });
  vi.spyOn(f.pins, "pinTree").mockImplementation(async (...args) => {
    const pin = await original(...args);
    if (args[1] !== "processing") return pin;
    return {
      ...pin,
      release: async () => {
        entered.resolve();
        await release.promise;
        if (deny) throw new Error("STORAGE_RECOVERY_PENDING");
        await pin.release();
      },
    };
  });
  return {
    entered,
    release,
    deny: (value: boolean) => {
      deny = value;
    },
  };
}

describe("W13 composed real account/raw realtime/cloud/media/Library I/O (synthetic boundaries)", () => {
  it.each(["url", "file"] as const)(
    "joins signed-in manual %s processing to verified owned bytes and one durable Library row",
    async (kind) => {
      const f = await fixture(),
        { scope, socket } = await f.signIn("alice"),
        { pending, confirmation } = await start(f, socket, kind);
      const download = f.media.download.bind(f.media);
      let downloadFailure: unknown;
      vi.spyOn(f.media, "download").mockImplementation(async (...args) => {
        try {
          return await download(...args);
        } catch (error) {
          downloadFailure = error;
          throw error;
        }
      });
      expect(f.library.controller.view()).toMatchObject({
        accountState: "live",
        tracks: [],
      });
      socket.snapshot("job", f.job(), f.jobId);
      const result = await pending;
      expect(downloadFailure).toBeUndefined();
      expect(result).toMatchObject({
        phase: "ready",
        busy: false,
        errorCode: null,
        job: { id: f.jobId, resultAvailable: true },
      });
      expect(result.resultCapability).toMatch(/^[a-f0-9-]{36}$/u);
      await vi.waitFor(() => expect(f.adoptions).toHaveLength(1));
      await f.adoptions[0]!.promise;
      expect(f.adoptionErrors).toEqual([]);
      expect(f.host.native.publishLibraryArtifact).toHaveBeenCalledWith(
        expect.any(String),
        "media",
      );
      expect(f.host.native.publishLibraryArtifact).toHaveBeenCalledWith(
        expect.any(String),
        "metadata",
      );
      const track = f.library.controller.view().tracks[0]!;
      expect(track).toMatchObject({
        jobId: f.jobId,
        accountOwned: true,
        offline: true,
        online: true,
        canExport: true,
        trimEnabled: false,
      });
      expect(f.library.controller.view().tracks).toHaveLength(1);
      const metadata = f.cloud.completedResult(result.resultCapability!, scope),
        artifact = await f.library.cache.lookup(
          metadata,
          scope,
          new AbortController().signal,
        );
      expect(artifact).toMatchObject({
        ownerUid: "alice",
        jobId: f.jobId,
        bytes: f.voice.length,
        sha256: Buffer.from(f.hash(f.voice), "base64").toString("hex"),
      });
      expect(
        await readFile(
          join(f.root, artifact!.relativePath.replaceAll("\\", "/")),
        ),
      ).toEqual(f.voice);
      expect(
        (await f.accountCatalog("alice")).jobs.map((row) => row.metadata.id),
      ).toEqual([f.jobId]);
      // A later account page snapshot merges the same delivered job without a second transfer/adoption.
      socket.snapshot("jobs", { items: [f.job()], next_cursor: null });
      await f.library.controller.flush();
      expect(f.library.controller.view().tracks).toHaveLength(1);
      expect(f.adoptions).toHaveLength(1);
      expect(f.media.activity().idle).toBe(true);
      expect(await f.pins.hasLiveConsumers()).toBe(false);
      expect(await f.controller.writes.readOwned()).toEqual([]);
      await expect(
        f.media.consumeResult(result.resultCapability!, scope),
      ).rejects.toThrow("ACCOUNT_CHANGED");
      await expect(
        f.cloud.confirm(confirmation.capability, true),
      ).rejects.toThrow("CLOUD_CONFIRMATION_INVALID");
      expect(await readFile(f.source)).toEqual(f.original);
      expect(f.uploaded).toEqual(kind === "file" ? [f.prepared] : []);
      expect(nativeCodec.run).toHaveBeenCalledTimes(kind === "file" ? 2 : 1);
      if (kind === "file") {
        const put = f.calls.find((call) => call.init.method === "PUT")!;
        expect(Object.fromEntries(new Headers(put.init.headers))).toMatchObject(
          {
            "content-type": "audio/mp4",
            "if-none-match": "*",
            "x-amz-checksum-sha256": f.input.sha256,
            "x-amz-meta-sha256": f.input.sha256,
          },
        );
        expect(
          f.calls.filter((call) =>
            call.url.pathname.endsWith("/upload-completions"),
          ),
        ).toHaveLength(1);
      }
      expectCommandOnlyBackend(f);
    },
  );

  it("retires captured A while the object response is pending and rejects its late bytes and stale socket under B", async () => {
    const f = await fixture(),
      { scope: a, socket: oldSocket } = await f.signIn("alice"),
      response = deferred<Response>();
    releaseHeldIo.push(() => response.resolve(f.voiceResponse()));
    f.setOutputResponse(() => response.promise);
    const { pending } = await start(f, oldSocket),
      oldMessage = oldSocket.onmessage,
      oldJobSubscription = oldSocket.subscription("job", f.jobId)!;
    oldSocket.snapshot("job", f.job(), f.jobId);
    await vi.waitFor(() =>
      expect(f.calls.some((call) => call.url.pathname === "/voice")).toBe(true),
    );
    expect(f.media.activity()).toMatchObject({
      pending: 1,
      grants: 0,
      workspaces: 1,
      idle: false,
    });
    const transfer = f.calls.find((call) => call.url.pathname === "/voice")!;
    await f.account.execute({ type: "LOGOUT" });
    const { scope: b } = await f.signIn("bob");
    expect(b.firebaseUid).toBe("bob");
    expect(b.generation).not.toBe(a.generation);
    expect(transfer.init.signal?.aborted).toBe(true);
    response.resolve(f.voiceResponse());
    await pending;
    oldMessage?.call(
      oldSocket as unknown as WebSocket,
      {
        data: JSON.stringify({
          type: "snapshot",
          protocol_version: 1,
          stream_id: oldSocket.stream,
          subscription_id: oldJobSubscription,
          sequence: 99,
          data: f.job(),
        }),
      } as MessageEvent,
    );
    await f.library.controller.flush();
    await vi.waitFor(() => expect(f.media.activity().idle).toBe(true));
    expect(f.cloud.view()).toMatchObject({
      phase: "idle",
      resultCapability: null,
      job: null,
      busy: false,
    });
    expect(f.library.controller.view().tracks).toEqual([]);
    expect(f.adoptions).toEqual([]);
    expect((await f.accountCatalog("bob")).jobs).toEqual([]);
    expect(await readdir(join(f.root, "cloud", "work"))).toEqual([]);
    expect(await f.controller.writes.readOwned()).toEqual([]);
    expect(await f.pins.hasLiveConsumers()).toBe(false);
    expect(nativeCodec.run).not.toHaveBeenCalled();
    expect(oldSocket.close).toHaveBeenCalled();
    expectCommandOnlyBackend(f, 2);
  });

  it("retains the borrowed A descriptor until close and refuses late completed-result adoption into B", async () => {
    const f = await fixture(),
      { scope: a, socket } = await f.signIn("alice"),
      entered = deferred<void>(),
      release = deferred<void>(),
      consume = f.files.consume.bind(f.files);
    releaseHeldIo.push(() => release.resolve());
    vi.spyOn(f.files, "consume").mockImplementation(
      async (capability, owner) => {
        const selected = await consume(capability, owner);
        if (owner.includes(":cloud:")) {
          entered.resolve();
          await release.promise;
        }
        return selected;
      },
    );
    const { pending } = await start(f, socket);
    socket.snapshot("job", f.job(), f.jobId);
    const ready = await pending;
    await entered.promise;
    expect(f.adoptions).toHaveLength(1);
    expect(f.adoptions[0]!.scope).toEqual(a);
    expect(f.media.activity().idle).toBe(false);
    expect(await f.pins.hasLiveConsumers()).toBe(true);
    await f.account.execute({ type: "LOGOUT" });
    await f.signIn("bob");
    expect(() => f.cloud.completedResult(ready.resultCapability!, a)).toThrow(
      "SESSION_CHANGED",
    );
    release.resolve();
    await f.adoptions[0]!.promise;
    expect(f.adoptionErrors).toHaveLength(1);
    expect(f.adoptionErrors[0]).toMatchObject({ name: "AbortError" });
    expect(f.library.controller.view().tracks).toEqual([]);
    expect((await f.accountCatalog("bob")).jobs).toEqual([]);
    expect((await f.accountCatalog("alice")).jobs).toEqual([]);
    expect(f.media.activity().idle).toBe(true);
    expect(await f.pins.hasLiveConsumers()).toBe(false);
    expect(await f.controller.writes.readOwned()).toEqual([]);
    await expect(
      readdir(join(f.root, "library", "media", libraryNamespace("bob"))),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expectCommandOnlyBackend(f, 2);
  });

  it.each(["cancel", "account-change"] as const)(
    "rechecks captured authority after %s while genuine prepared-media close is pending",
    async (action) => {
      const f = await fixture(),
        { socket } = await f.signIn("alice"),
        cleanup = preparedCleanup(f),
        reservations = vi.spyOn(f.controller, "reserveScratch"),
        { pending } = await start(f, socket, "file");
      socket.snapshot("job", f.job(), f.jobId);
      await cleanup.entered.promise;
      expect(f.uploaded).toEqual([f.prepared]);
      expect(f.media.activity().idle).toBe(false);
      expect(await f.pins.hasLiveConsumers()).toBe(true);
      expect(reservations).toHaveBeenCalledOnce();
      expect(f.calls.some((call) => call.url.pathname === "/voice")).toBe(
        false,
      );
      if (action === "cancel") {
        expect(await f.cloud.cancel()).toMatchObject({
          phase: "cancellation-requested",
          busy: true,
          errorCode: null,
        });
      } else {
        await f.account.execute({ type: "LOGOUT" });
        await f.signIn("bob");
      }
      cleanup.release.resolve();
      await pending;
      expect(f.cloud.view()).toMatchObject({
        phase: action === "cancel" ? "cancellation-requested" : "idle",
        busy: false,
        resultCapability: null,
        errorCode: null,
      });
      expect(f.adoptions).toEqual([]);
      expect(f.calls.some((call) => call.url.pathname === "/voice")).toBe(
        false,
      );
      expect(reservations).toHaveBeenCalledOnce();
      expect(nativeCodec.run).toHaveBeenCalledOnce();
      expect(f.media.activity().idle).toBe(true);
      expect(await f.pins.hasLiveConsumers()).toBe(false);
      expect(await f.controller.writes.readOwned()).toEqual([]);
      expect(await readFile(f.source)).toEqual(f.original);
    },
  );

  it("keeps uncertain prepared cleanup active and admits no output request or replacement workspace", async () => {
    const f = await fixture(),
      { socket } = await f.signIn("alice"),
      cleanup = preparedCleanup(f),
      reservations = vi.spyOn(f.controller, "reserveScratch"),
      { pending } = await start(f, socket, "file");
    cleanup.deny(true);
    socket.snapshot("job", f.job(), f.jobId);
    await cleanup.entered.promise;
    cleanup.release.resolve();
    expect(await pending).toMatchObject({
      phase: "failed",
      resultCapability: null,
      errorCode: "CLOUD_REQUEST_FAILED",
    });
    expect(f.calls.some((call) => call.url.pathname === "/voice")).toBe(false);
    expect(reservations).toHaveBeenCalledOnce();
    expect(nativeCodec.run).toHaveBeenCalledOnce();
    expect(f.adoptions).toEqual([]);
    expect(f.media.activity()).toMatchObject({ workspaces: 1, idle: false });
    expect(await f.pins.hasLiveConsumers()).toBe(true);
    cleanup.deny(false);
    await f.media.dispose();
    expect(f.media.activity().idle).toBe(true);
    expect(await f.pins.hasLiveConsumers()).toBe(false);
    expect(await readFile(f.source)).toEqual(f.original);
  });
});
