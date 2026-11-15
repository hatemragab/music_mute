import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  WindowsPreparationOperations,
  type ReadyReceipt,
} from "../src/main/prepare/operations.js";
import type { HostContext } from "../src/main/host-context.js";
import type { PrivateFileFingerprint } from "../src/main/prepare/private-files.js";
import type {
  StartupReadinessCache,
  ReadinessBinding,
} from "../src/main/prepare/readiness-cache.js";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import { parseQualificationEvidence } from "../../worker/src/enrollment/report-builder.js";
import type { QualificationResult } from "../src/main/prepare/qualification-runner.js";
import { receipt, gpu, sid } from "./fixtures/prepare.js";
const fixtureState = vi.hoisted(() => ({
  fingerprint: null as PrivateFileFingerprint | null,
  capsules: new Map<string, Buffer>(),
  modelHashes: [] as string[],
}));
vi.mock("../src/main/prepare/private-files.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/main/prepare/private-files.js")
  >("../src/main/prepare/private-files.js");
  return {
    ...actual,
    privateFingerprint: async () => ({ ...fixtureState.fingerprint! }),
    verifyPrivateFile: async () => ({
      sha256: fixtureState.modelHashes.shift() ?? MODEL.sha256,
      fingerprint: { ...fixtureState.fingerprint! },
    }),
    writePrivateAtomic: async (
      _host: HostContext,
      path: string,
      bytes: Buffer,
    ) => {
      fixtureState.capsules.set(path, Buffer.from(bytes));
    },
    readPrivateBytes: async (_host: HostContext, path: string) =>
      Buffer.from(fixtureState.capsules.get(path)!),
  };
});
afterEach(() => {
  fixtureState.capsules.clear();
  fixtureState.modelHashes = [];
  vi.restoreAllMocks();
});
function fixture() {
  const previous = receipt(),
    current: ReadyReceipt = {
      ...previous,
      version: 2,
      modelFingerprint: { ...previous.modelFingerprint, fileId: "84" },
    };
  fixtureState.fingerprint = { ...current.modelFingerprint };
  let marker: Buffer | null = Buffer.from("old fingerprint marker");
  const events: string[] = [];
  const native = {
    vaultRead: vi.fn(async () => (marker ? Buffer.from(marker) : null)),
    vaultWrite: vi.fn(
      async (_namespace: string, _key: string, bytes: Buffer) => {
        events.push("marker");
        marker = Buffer.from(bytes);
      },
    ),
    vaultDelete: vi.fn(async () => {
      events.push("invalidate");
      marker = null;
    }),
    enumerateGpus: vi.fn(async () => [{ ...gpu }]),
    bootIdentity: vi.fn(async () => current.bootIdentity),
  };
  const host = {
    native,
    identity: { sid },
    report: { installationId: "a989d129-1c23-47ea-bb02-e6ea6b7a9901" },
  } as unknown as HostContext;
  const operations = new WindowsPreparationOperations(
    host,
    "C:\\fixture",
    async () => true,
  );
  const internals = operations as unknown as {
    receipt(): Promise<ReadyReceipt>;
    verifyRelease(release: string): Promise<{
      manifestSha256: string;
      manifest: { entries: { kind: string; path: string }[] };
    }>;
    startup: StartupReadinessCache;
  };
  const read = vi.spyOn(internals, "receipt").mockResolvedValue(current),
    verify = vi.spyOn(internals, "verifyRelease").mockResolvedValue({
      manifestSha256: current.manifestSha256,
      manifest: {
        entries: [
          { kind: "file", path: "runtime/native/musicmute-native.exe" },
          { kind: "directory", path: "app" },
        ],
      },
    });
  return {
    operations,
    internals,
    native,
    events,
    previous,
    current,
    read,
    verify,
    getMarker: () => marker,
  };
}
it("rebuilds the existing authenticated capsule for restored model file identity without inference", async () => {
  const f = fixture();
  await f.operations.recaptureStartupReceipt(new AbortController().signal);
  expect(f.events).toEqual(["invalidate", "marker"]);
  expect(f.verify).toHaveBeenCalledWith(f.current.release);
  const marker = JSON.parse(f.getMarker()!.toString("utf8")),
    bytes = fixtureState.capsules.get(marker.path)!;
  expect(marker.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  const capsule = JSON.parse(bytes.toString("utf8")) as {
    binding: ReadinessBinding;
    files: { path: string; fingerprint: PrivateFileFingerprint }[];
  };
  expect(
    capsule.files.find((row) => row.path.startsWith("models\\"))?.fingerprint
      .fileId,
  ).toBe("84");
  expect(f.previous.modelFingerprint.fileId).toBe("42");
  expect(capsule.files).toHaveLength(4);
  expect(
    (
      await f.internals.startup.check(
        capsule.binding,
        new AbortController().signal,
      )
    ).ready,
  ).toBe(true);
});
it("changed current driver refuses capsule publication", async () => {
  const f = fixture();
  f.native.enumerateGpus.mockResolvedValueOnce([
    { ...gpu, driverVersion: "32.0.2.3" },
  ]);
  await expect(
    f.operations.recaptureStartupReceipt(new AbortController().signal),
  ).rejects.toThrow();
  expect(f.native.vaultWrite).not.toHaveBeenCalled();
  expect(fixtureState.capsules.size).toBe(0);
});
it("mismatched restored file fingerprint or signed manifest cannot establish warm readiness", async () => {
  const f = fixture();
  fixtureState.fingerprint = { ...f.current.modelFingerprint, fileId: "99" };
  await expect(
    f.operations.recaptureStartupReceipt(new AbortController().signal),
  ).rejects.toThrow("INTEGRITY_INVALID");
  fixtureState.fingerprint = { ...f.current.modelFingerprint };
  f.verify.mockResolvedValueOnce({
    manifestSha256: "f".repeat(64),
    manifest: { entries: [] },
  });
  await expect(
    f.operations.recaptureStartupReceipt(new AbortController().signal),
  ).rejects.toThrow("INTEGRITY_INVALID");
  expect(f.native.vaultWrite).not.toHaveBeenCalled();
});
it("cancellation runs no receipt validation, native operation or capsule write", async () => {
  const f = fixture(),
    abort = new AbortController();
  abort.abort();
  await expect(
    f.operations.recaptureStartupReceipt(abort.signal),
  ).rejects.toThrow();
  expect(f.read).not.toHaveBeenCalled();
  expect(f.native.vaultDelete).not.toHaveBeenCalled();
  expect(fixtureState.capsules.size).toBe(0);
});

function requalificationFixture() {
  const f = fixture(),
    stored = new Map<string, Buffer>([
      [
        "ready_receipt",
        Buffer.from(
          JSON.stringify({ ...f.previous, bootIdentity: "f".repeat(64) }),
        ),
      ],
    ]);
  const target = vi
    .spyOn(f.operations, "target")
    .mockImplementation(async () => {
      f.events.push("target:attested");
      return { sid, identity: f.current.target };
    });
  const markerRead = f.native.vaultRead.getMockImplementation()!,
    markerWrite = f.native.vaultWrite.getMockImplementation()!;
  f.native.vaultRead.mockImplementation(
    async (_namespace?: string, key?: string) =>
      key === "ready_receipt" ? Buffer.from(stored.get(key)!) : markerRead(),
  );
  f.native.vaultWrite.mockImplementation(async (ns, key, bytes) => {
    if (key === "ready_receipt") {
      f.events.push("ready");
      stored.set(key, Buffer.from(bytes));
    } else await markerWrite(ns, key, bytes);
  });
  f.read.mockImplementation(
    async () =>
      JSON.parse(stored.get("ready_receipt")!.toString()) as ReadyReceipt,
  );
  const internals = f.operations as unknown as {
    runner: {
      run(release: string, signal: AbortSignal): Promise<QualificationResult>;
    };
  };
  const qualify = vi
    .spyOn(internals.runner, "run")
    .mockImplementation(async () => {
      f.events.push("qualify");
      return {
        bootIdentity: f.current.bootIdentity,
        raw: f.current.qualification,
        evidence: parseQualificationEvidence(f.current.qualification, {
          runtimeProfile: "windows-user",
          expectedUserSid: sid,
          expectedFixtureDigest: f.current.fixtureSha256,
        }),
      };
    });
  return { ...f, stored, qualify, target };
}
it("restored new model file and stale witness require fresh GPU qualification before Ready/capsule publication", async () => {
  const f = requalificationFixture(),
    old = JSON.parse(f.stored.get("ready_receipt")!.toString()) as ReadyReceipt;
  await f.operations.requalifyInstalled(new AbortController().signal);
  const next = JSON.parse(
    f.stored.get("ready_receipt")!.toString(),
  ) as ReadyReceipt;
  expect(f.qualify).toHaveBeenCalledWith(
    old.release,
    expect.any(AbortSignal),
    undefined,
    undefined,
  );
  expect(f.events).toEqual([
    "target:attested",
    "qualify",
    "invalidate",
    "ready",
    "invalidate",
    "marker",
  ]);
  expect(next.bootIdentity).toBe(await f.native.bootIdentity());
  expect(next.modelFingerprint.fileId).toBe("84");
  expect(old.modelFingerprint.fileId).toBe("42");
  expect(next.activatedAt).toBe(old.activatedAt);
  expect(next.sequence).toBe(old.sequence);
  expect(f.native.vaultWrite.mock.calls.map((c) => c[1])).not.toContain(
    "runtime_sequence",
  );
});
it("wrong current witness, changed model bytes, or untrusted guarded output never writes Ready", async () => {
  const f = requalificationFixture(),
    before = Buffer.from(f.stored.get("ready_receipt")!);
  f.qualify.mockResolvedValueOnce({
    ...(await f.qualify(f.current.release, new AbortController().signal)),
    bootIdentity: "9".repeat(64),
  });
  f.qualify.mockClear();
  await expect(
    f.operations.requalifyInstalled(new AbortController().signal),
  ).rejects.toThrow("INTEGRITY_INVALID");
  expect(f.stored.get("ready_receipt")).toEqual(before);
  expect(f.native.vaultWrite).not.toHaveBeenCalled();
  fixtureState.modelHashes = [MODEL.sha256, "9".repeat(64)];
  await expect(
    f.operations.requalifyInstalled(new AbortController().signal),
  ).rejects.toThrow("INTEGRITY_INVALID");
  expect(f.native.vaultWrite).not.toHaveBeenCalled();
  f.qualify.mockResolvedValueOnce({
    ...(await f.qualify(f.current.release, new AbortController().signal)),
    raw: {
      ...(f.current.qualification as Record<string, unknown>),
      providerDispatch: {
        ...((f.current.qualification as Record<string, unknown>)
          .providerDispatch as Record<string, unknown>),
        cpuNodeEvents: 1,
      },
    },
  });
  await expect(
    f.operations.requalifyInstalled(new AbortController().signal),
  ).rejects.toThrow();
  expect(f.native.vaultWrite).not.toHaveBeenCalled();
});

it("legacy unbound v1 metadata is migrated only after full installed proof and a fresh guarded current-witness result", async () => {
  const f = requalificationFixture(),
    raw = JSON.parse(f.stored.get("ready_receipt")!.toString());
  delete raw.bootIdentity;
  raw.version = 1;
  raw.qualification = { untrustedLegacy: true };
  f.stored.set("ready_receipt", Buffer.from(JSON.stringify(raw)));
  await f.operations.requalifyInstalled(new AbortController().signal);
  const next = JSON.parse(
    f.stored.get("ready_receipt")!.toString(),
  ) as ReadyReceipt;
  expect(f.qualify).toHaveBeenCalledOnce();
  expect(next.version).toBe(2);
  expect(next.bootIdentity).toBe(await f.native.bootIdentity());
  expect(next.qualification).toEqual(f.current.qualification);
  expect(next.activatedAt).toBe(raw.activatedAt);
  expect(next.sequence).toBe(raw.sequence);
});

it("rollback qualification refuses a different signed target before any GPU or Ready write", async () => {
  const f = requalificationFixture();
  f.target.mockResolvedValueOnce({ sid, identity: "9".repeat(64) });
  await expect(
    f.operations.requalifyInstalled(new AbortController().signal),
  ).rejects.toThrow("INTEGRITY_INVALID");
  expect(f.qualify).not.toHaveBeenCalled();
  expect(f.native.vaultWrite).not.toHaveBeenCalled();
});

it("trusted fleet alignment qualifies the fixed PERSONAL fixture on the approved current adapter without editing old approval or model bytes", async () => {
  const f = requalificationFixture(),
    selection = {
      approvedGpu: {
        ...gpu,
        deviceId: 9999,
        luid: "0000000000000099",
        deviceIndex: 7,
      },
      expectedBootIdentity: f.current.bootIdentity,
      allowLuidRebind: false,
    },
    original = f.current.qualification as Record<string, unknown>,
    raw = {
      ...original,
      gpuId: `dxgi-${selection.approvedGpu.luid}`,
      directmlDeviceId: 7,
      gpuIdentity: selection.approvedGpu,
    };
  f.native.enumerateGpus.mockResolvedValue([selection.approvedGpu]);
  f.qualify.mockResolvedValueOnce({
    bootIdentity: f.current.bootIdentity,
    raw,
    evidence: parseQualificationEvidence(raw, {
      runtimeProfile: "windows-user",
      expectedUserSid: sid,
      expectedFixtureDigest: f.current.fixtureSha256,
    }),
  });
  await f.operations.requalifyInstalled(
    new AbortController().signal,
    selection,
  );
  expect(f.qualify).toHaveBeenCalledWith(
    f.current.release,
    expect.any(AbortSignal),
    undefined,
    selection,
  );
  const next = JSON.parse(f.stored.get("ready_receipt")!.toString());
  expect(next.fixtureSha256).toBe(f.current.fixtureSha256);
  expect(next.qualification.gpuIdentity).toEqual(selection.approvedGpu);
  expect(next.modelSha256).toBe(f.current.modelSha256);
  expect(next.activatedAt).toBe(f.current.activatedAt);
});
