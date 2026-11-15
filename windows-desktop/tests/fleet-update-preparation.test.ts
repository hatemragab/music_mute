import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { expect, it, vi } from "vitest";
import { record } from "./fleet-fixtures.js";
import { receipt } from "./fixtures/prepare.js";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import { parseQualificationEvidence } from "../../worker/src/enrollment/report-builder.js";
import {
  refreshFleetAfterConsumerUpdate,
  refreshApprovedFleetRuntime,
} from "../src/main/fleet/update-preparation.js";
import { readActiveFleetIdentity } from "../src/main/fleet/active-runtime.js";
import type { HostContext } from "../src/main/host-context.js";
import {
  selectTrustedPreparationGpu,
  type TrustedPreparationGpuSelection,
} from "../src/main/prepare/qualification-runner.js";
import type { WindowsPreparationOperations } from "../src/main/prepare/operations.js";
function fixture() {
  const r = record(),
    personalRoot = "C:\\Users\\fixture\\AppData\\Local\\MusicMuteLocal";
  r.prepared.modelDigest = MODEL.sha256;
  r.prepared.report.runtime.modelDigest = MODEL.sha256;
  r.prepared.qualificationPath = win32.join(
    personalRoot,
    `prepare\\approved\\qualification-${createHash("sha256").update(r.requests.report).digest("hex")}.json`,
  );
  const original = {
    ...receipt().qualification,
    serviceIdentity: r.sid,
    gpuId: `dxgi-${r.prepared.gpu.luid}`,
    directmlDeviceId: r.prepared.gpu.deviceIndex,
    gpuIdentity: r.prepared.gpu,
    fixtureDigest: r.prepared.fixtureDigest,
    resourceObservations: {
      inferenceSlots: 1,
      dedicatedVideoMemoryLimitBytes: r.prepared.gpu.dedicatedVideoMemoryBytes,
      sharedSystemMemoryLimitBytes: r.prepared.gpu.sharedSystemMemoryLimitBytes,
    },
  };
  const raw = { ...original, releaseManifestDigest: "f".repeat(64) },
    ready = {
      bootIdentity: receipt().bootIdentity,
      release: "e".repeat(64),
      archiveSha256: "1".repeat(64),
      manifestSha256: "f".repeat(64),
      nativeSha256: "d".repeat(64),
      modelSha256: MODEL.sha256,
      evidence: { gpuIdentity: { ...r.prepared.gpu } },
    };
  const data = new Map<string, Buffer>([
      ["fleet:enrollment", Buffer.from(JSON.stringify(r))],
      ["fleet:capacity", Buffer.from("prior capacity")],
    ]),
    events: string[] = [];
  const identity = {
      sid: r.sid,
      sessionId: 1,
      pid: 12345,
      creationTime: "133000000000000000",
    },
    lease = {
      scope: "prepare" as const,
      nonce: "a".repeat(64),
      identity,
      abandoned: false,
    };
  const native = {
    enumerateGpus: async () => [raw.gpuIdentity],
    bootIdentity: async () => ready.bootIdentity,
    vaultRead: async (namespace: string, key: string) =>
      data.has(`${namespace}:${key}`)
        ? Buffer.from(data.get(`${namespace}:${key}`)!)
        : null,
    vaultWrite: async (namespace: string, key: string, bytes: Buffer) => {
      events.push(`write:${key}`);
      data.set(`${namespace}:${key}`, Buffer.from(bytes));
    },
    vaultDelete: async (namespace: string, key: string) => {
      events.push(`delete:${key}`);
      data.delete(`${namespace}:${key}`);
    },
    acquireMutex: vi.fn(async () => ({ ...lease, scope: "cache" as const })),
    releaseMutex: vi.fn(async () => {}),
  };
  const options = {
    host: { native, identity, personalRoot } as unknown as HostContext,
    operations: {
      snapshotReady: vi.fn(async () => ({ ...ready })),
      requalifyInstalled: vi.fn(
        async (
          signal: AbortSignal,
          selection?: TrustedPreparationGpuSelection,
        ) => {
          signal.throwIfAborted();
          if (!selection) throw Error("selection required");
          ready.evidence.gpuIdentity = selectTrustedPreparationGpu(
            selection,
            await native.bootIdentity(),
            await native.enumerateGpus(),
          );
        },
      ),
    } as unknown as Pick<
      WindowsPreparationOperations,
      "snapshotReady" | "requalifyInstalled"
    >,
    prepareLease: lease,
    transaction: "a989d129-1c23-47ea-bb02-e6ea6b7a9901",
    updateIdentity: "7".repeat(64),
    readFixture: vi.fn(async () => ({
      relativePath: `prepare\\approved\\${r.prepared.fixtureDigest}.wav`,
      bytes: 100,
      sha256: r.prepared.fixtureDigest,
    })),
    readOriginalQualification: vi.fn(async () => original),
    qualify: vi.fn(async () => ({
      bootIdentity: ready.bootIdentity,
      raw,
      evidence: parseQualificationEvidence(raw, {
        runtimeProfile: "windows-user",
        expectedUserSid: r.sid,
        expectedFixtureDigest: r.prepared.fixtureDigest,
      }),
    })),
  };
  return { r, data, events, native, options, ready, raw };
}
it("requalifies an enrolled approved fixture after a new boot without an app update or enrollment mutation", async () => {
  const f = fixture(),
    before = Buffer.from(f.data.get("fleet:enrollment")!),
    recordedBoot = f.options.host.native.bootIdentity;
  f.r.prepared.bootIdentity = "f".repeat(64);
  f.data.set("fleet:enrollment", Buffer.from(JSON.stringify(f.r)));
  const immutable = Buffer.from(f.data.get("fleet:enrollment")!),
    { updateIdentity, ...options } = f.options;
  void updateIdentity;
  f.ready.release = f.r.prepared.release;
  f.ready.manifestSha256 = f.r.prepared.manifestDigest;
  f.ready.archiveSha256 = f.r.prepared.archiveDigest;
  f.raw.releaseManifestDigest = f.ready.manifestSha256;
  const proof = await refreshApprovedFleetRuntime(
    { ...options, runtimeIdentity: f.ready.release },
    new AbortController().signal,
  );
  expect(proof?.bootIdentity).toBe(await recordedBoot());
  expect(f.data.get("fleet:enrollment")).toEqual(immutable);
  expect(f.options.qualify).toHaveBeenCalledOnce();
  expect(f.options.qualify.mock.calls[0]).toContainEqual({
    relativePath: `prepare\\approved\\${f.r.prepared.fixtureDigest}.wav`,
    bytes: 100,
    sha256: f.r.prepared.fixtureDigest,
  });
  expect(before).not.toEqual(immutable);
});
it("a boot change during qualification never publishes an overlay or retires capacity", async () => {
  const f = fixture();
  f.options.qualify.mockResolvedValueOnce({
    ...(await f.options.qualify()),
    bootIdentity: "f".repeat(64),
  });
  f.options.qualify.mockClear();
  await expect(
    refreshFleetAfterConsumerUpdate(f.options, new AbortController().signal),
  ).rejects.toThrow("FLEET_PREPARE_REQUIRED");
  expect(f.events).toEqual([]);
  expect(f.data.get("fleet:capacity")?.toString()).toBe("prior capacity");
});
it("requalifies the immutable approved fixture and publishes local overlay after capacity invalidation", async () => {
  const f = fixture(),
    original = Buffer.from(f.data.get("fleet:enrollment")!);
  const proof = await refreshFleetAfterConsumerUpdate(
    f.options,
    new AbortController().signal,
  );
  expect(proof?.release).toBe(f.ready.release);
  expect(f.events).toEqual(["delete:capacity", "write:active_runtime"]);
  expect(f.data.get("fleet:enrollment")).toEqual(original);
  expect(f.options.qualify).toHaveBeenCalledWith(
    f.ready.release,
    {
      relativePath: `prepare\\approved\\${f.r.prepared.fixtureDigest}.wav`,
      bytes: 100,
      sha256: f.r.prepared.fixtureDigest,
    },
    expect.any(AbortSignal),
    {
      approvedGpu: f.r.prepared.gpu,
      expectedBootIdentity: f.ready.bootIdentity,
      allowLuidRebind: false,
    },
  );
  expect(await readActiveFleetIdentity(f.native, f.r)).toMatchObject({
    source: "consumer-update",
    release: f.ready.release,
  });
  expect(f.native.releaseMutex).toHaveBeenCalledOnce();
});
it("already matching overlay is idempotent and does not rerun GPU or clear new capacity", async () => {
  const f = fixture();
  await refreshFleetAfterConsumerUpdate(
    f.options,
    new AbortController().signal,
  );
  f.data.set("fleet:capacity", Buffer.from("new qualified capacity"));
  await refreshFleetAfterConsumerUpdate(
    f.options,
    new AbortController().signal,
  );
  expect(f.options.qualify).toHaveBeenCalledOnce();
  expect(f.data.get("fleet:capacity")?.toString()).toBe(
    "new qualified capacity",
  );
});
it("machine replacement during qualification cannot receive old proof or capacity deletion", async () => {
  const f = fixture();
  f.options.qualify.mockImplementationOnce(async () => {
    f.data.set(
      "fleet:enrollment",
      Buffer.from(
        JSON.stringify({
          ...f.r,
          machineCredential: "n".repeat(43),
          credentialRevision: 2,
        }),
      ),
    );
    return {
      bootIdentity: f.ready.bootIdentity,
      raw: f.raw,
      evidence: parseQualificationEvidence(f.raw, {
        runtimeProfile: "windows-user",
        expectedUserSid: f.r.sid,
        expectedFixtureDigest: f.r.prepared.fixtureDigest,
      }),
    };
  });
  await expect(
    refreshFleetAfterConsumerUpdate(f.options, new AbortController().signal),
  ).rejects.toThrow("UPDATE_FLEET_CHANGED");
  expect(f.events).toEqual([]);
  expect(f.data.has("fleet:capacity")).toBe(true);
  expect(f.native.releaseMutex).toHaveBeenCalledOnce();
});
it("Ready target change during qualification refuses publication", async () => {
  const f = fixture();
  vi.mocked(f.options.operations.snapshotReady)
    .mockResolvedValueOnce(f.ready as never)
    .mockResolvedValueOnce({
      ...f.ready,
      manifestSha256: "9".repeat(64),
    } as never);
  await expect(
    refreshFleetAfterConsumerUpdate(f.options, new AbortController().signal),
  ).rejects.toThrow("UPDATE_RUNTIME_CHANGED");
  expect(f.events).toEqual([]);
});
it("personal fixture substitution and unheld/foreign Prepare authority fail before GPU qualification", async () => {
  const f = fixture();
  f.options.readFixture.mockResolvedValueOnce({
    relativePath: `prepare\\approved\\${"8".repeat(64)}.wav`,
    bytes: 100,
    sha256: "8".repeat(64),
  });
  await expect(
    refreshFleetAfterConsumerUpdate(f.options, new AbortController().signal),
  ).rejects.toThrow("UPDATE_FLEET_FIXTURE_UNAVAILABLE");
  await expect(
    refreshFleetAfterConsumerUpdate(
      {
        ...f.options,
        prepareLease: {
          ...f.options.prepareLease,
          identity: {
            ...f.options.prepareLease.identity,
            sid: "S-1-5-21-1-2-3-1002",
          },
        },
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("UPDATE_MAINTENANCE_REQUIRED");
  expect(f.options.qualify).not.toHaveBeenCalled();
});
it("cache contention and failed GPU-only evidence preserve the old authority", async () => {
  const f = fixture();
  f.native.acquireMutex.mockResolvedValueOnce(null as never);
  await expect(
    refreshFleetAfterConsumerUpdate(f.options, new AbortController().signal),
  ).rejects.toThrow("UPDATE_BUSY");
  expect(f.events).toEqual([]);
  f.options.qualify.mockResolvedValueOnce({
    bootIdentity: f.ready.bootIdentity,
    raw: {
      ...f.raw,
      providerDispatch: { ...f.raw.providerDispatch, cpuNodeEvents: 1 },
    },
    evidence: {} as never,
  });
  await expect(
    refreshFleetAfterConsumerUpdate(f.options, new AbortController().signal),
  ).rejects.toThrow("FLEET_ACTIVE_RUNTIME_INVALID");
  expect(f.events).toEqual([]);
});
it("inactive or revoked enrollment never becomes active through an update", async () => {
  const f = fixture();
  f.data.set(
    "fleet:enrollment",
    Buffer.from(JSON.stringify({ ...f.r, phase: "revoked" })),
  );
  expect(
    await refreshFleetAfterConsumerUpdate(
      f.options,
      new AbortController().signal,
    ),
  ).toBeNull();
  expect(f.options.qualify).not.toHaveBeenCalled();
  expect(f.events).toEqual([]);
});

it("a stale same-user helper birth cannot act as the held Prepare lease", async () => {
  const f = fixture();
  await expect(
    refreshApprovedFleetRuntime(
      {
        ...f.options,
        runtimeIdentity: f.ready.release,
        prepareLease: {
          ...f.options.prepareLease,
          identity: {
            ...f.options.prepareLease.identity,
            creationTime: "133000000000000001",
          },
        },
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("UPDATE_MAINTENANCE_REQUIRED");
  expect(f.options.qualify).not.toHaveBeenCalled();
  expect(f.events).toEqual([]);
});

it("a witness change at final DXGI publication preserves old capacity and cannot write a stale overlay", async () => {
  const f = fixture();
  f.native.enumerateGpus = async () => {
    f.native.bootIdentity = async () => "9".repeat(64);
    return [f.raw.gpuIdentity];
  };
  await expect(
    refreshApprovedFleetRuntime(
      { ...f.options, runtimeIdentity: f.ready.release },
      new AbortController().signal,
    ),
  ).rejects.toThrow("FLEET_PREPARE_REQUIRED");
  expect(f.events).toEqual([]);
  expect(f.data.get("fleet:capacity")?.toString()).toBe("prior capacity");
});

it("a changed actual secondary-driver requalifies that exact approved adapter and aligns PERSONAL before the approved fixture", async () => {
  const f = fixture();
  await refreshFleetAfterConsumerUpdate(
    f.options,
    new AbortController().signal,
  );
  f.events.length = 0;
  f.options.qualify.mockClear();
  const approved = {
      ...f.r.prepared.gpu,
      driverVersion: "32.0.9.9",
      deviceIndex: 7,
    },
    primary = {
      ...approved,
      luid: "0000000000000001",
      deviceId: 9999,
      deviceIndex: 0,
      dedicatedVideoMemoryBytes: 16 * 1024 ** 3,
    };
  f.ready.evidence.gpuIdentity = primary;
  f.raw.gpuIdentity = approved;
  f.raw.directmlDeviceId = 7;
  f.native.enumerateGpus = async () => [primary, approved];
  const proof = await refreshFleetAfterConsumerUpdate(
    f.options,
    new AbortController().signal,
  );
  expect(proof?.qualification).toMatchObject({
    directmlDeviceId: 7,
    gpuIdentity: { luid: approved.luid, driverVersion: approved.driverVersion },
  });
  expect(f.options.operations.requalifyInstalled).toHaveBeenCalledOnce();
  expect(f.options.qualify).toHaveBeenCalledOnce();
  expect(f.ready.evidence.gpuIdentity).toEqual(approved);
  expect(f.data.has("fleet:capacity")).toBe(false);
});
it("latest current-witness overlay cannot be relaxed by an older original witness to approve another LUID", async () => {
  const f = fixture();
  f.r.prepared.bootIdentity = "f".repeat(64);
  f.data.set("fleet:enrollment", Buffer.from(JSON.stringify(f.r)));
  f.raw.gpuIdentity = { ...f.raw.gpuIdentity, luid: "0000000000004321" };
  f.raw.gpuId = `dxgi-${f.raw.gpuIdentity.luid}`;
  await refreshFleetAfterConsumerUpdate(
    f.options,
    new AbortController().signal,
  );
  f.events.length = 0;
  f.options.qualify.mockClear();
  f.data.set("fleet:capacity", Buffer.from("retain current"));
  f.ready.manifestSha256 = "9".repeat(64);
  f.native.enumerateGpus = async () => [
    { ...f.raw.gpuIdentity, luid: "0000000000009999" },
  ];
  await expect(
    refreshFleetAfterConsumerUpdate(f.options, new AbortController().signal),
  ).rejects.toThrow("GPU_UNSUPPORTED");
  expect(f.options.qualify).not.toHaveBeenCalled();
  expect(f.events).toEqual([]);
  expect(f.data.get("fleet:capacity")?.toString()).toBe("retain current");
});
