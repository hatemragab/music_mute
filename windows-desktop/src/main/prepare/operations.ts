import { createHash } from "node:crypto";
import { lstat, readFile, rename, statfs } from "node:fs/promises";
import { win32 } from "node:path";
import {
  verifyWindowsRelease,
  parseWindowsReleaseManifest,
  type WindowsReleaseManifest,
} from "../../../../worker/src/platform/windows/release-manifest.js";
import {
  parseQualificationEvidence,
  resolveQualifiedGpuIdentity,
  type QualificationEvidence,
} from "../../../../worker/src/enrollment/report-builder.js";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import type { HostContext } from "../host-context.js";
import {
  PrepareFailure,
  preparationFailure,
  type PreparationOperations,
  type PrepareLease,
  type PrepareTarget,
} from "./controller.js";
import { loadPreparationBundle, type PreparationBundle } from "./bundle.js";
import {
  extractVerifiedArchive,
  planVerifiedArchive,
  MAX_UNPACKED_BYTES,
} from "./verified-archive.js";
import {
  downloadPrivatePreparationArtifact,
  removePreparationArchive,
} from "./private-transfer.js";
import { PREPARATION_FIXTURE, preparationFixture } from "./fixture.js";
import {
  hashPrivateFile,
  readPrivateBytes,
  privateFingerprint,
  verifyPrivateFile,
  writePrivateAtomic,
  type PrivateFileFingerprint,
} from "./private-files.js";
import {
  PreparationQualificationRunner,
  assertApprovedPreparationFixture,
  type ApprovedPreparationFixture,
  type QualificationResult,
  type TrustedPreparationGpuSelection,
} from "./qualification-runner.js";
import {
  StartupReadinessCache,
  type ReadinessBinding,
  type ReadinessMeasurement,
} from "./readiness-cache.js";
import { verifyBrowserIntegration } from "../browser/registration.js";
import { RuntimeStaging, RUNTIME_STAGING_PATH } from "./runtime-staging.js";
import { RuntimeRepair } from "./runtime-repair.js";
import {
  RuntimeStatusCache,
  type RuntimeStatusBinding,
} from "./runtime-status-cache.js";
import type { ConsumerGpuIdentity } from "../../../../worker/src/platform/windows/consumer-native.js";
import type { LocalStartupMeasurements } from "./startup-measurements.js";
import {
  auditWindowsConsumerDlls,
  CONSUMER_DLL_POLICY,
} from "../../../../worker/src/platform/windows/consumer-dlls.js";
import {
  parseInstalledReadyMetadata,
  type InstalledReadyMetadata,
} from "../update/installed-runtime.js";

export interface RuntimeProof {
  version: 2;
  dllPolicy: typeof CONSUMER_DLL_POLICY;
  sid: string;
  release: string;
  archiveSha256: string;
  manifestSha256: string;
  sequence: number;
}
export interface ReadyReceipt {
  version: 2;
  bootIdentity: string;
  sid: string;
  target: string;
  release: string;
  sequence: number;
  manifestSha256: string;
  modelSha256: string;
  fixtureSha256: string;
  modelFingerprint: PrivateFileFingerprint;
  qualification: unknown;
  activatedAt: string;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PrepareFailure("INTEGRITY_INVALID");
  return value as Record<string, unknown>;
}
export function parseRuntimeProof(
  value: unknown,
  expected: {
    sid: string;
    release: string;
    archiveSha256: string;
    sequence: number;
  },
): RuntimeProof {
  const row = record(value);
  if (
    Object.keys(row).length !== 7 ||
    row.version !== 2 ||
    row.dllPolicy !== CONSUMER_DLL_POLICY ||
    row.sid !== expected.sid ||
    row.release !== expected.release ||
    row.archiveSha256 !== expected.archiveSha256 ||
    row.sequence !== expected.sequence ||
    typeof row.manifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.manifestSha256)
  )
    throw new PrepareFailure("INTEGRITY_INVALID");
  return row as unknown as RuntimeProof;
}
export function parseReadyReceipt(
  value: unknown,
  target: PrepareTarget,
  expectedBootIdentity?: string,
): { receipt: ReadyReceipt; evidence: QualificationEvidence } {
  const row = record(value);
  if (
    Object.keys(row).length !== 12 ||
    row.version !== 2 ||
    typeof row.bootIdentity !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.bootIdentity) ||
    (expectedBootIdentity !== undefined &&
      row.bootIdentity !== expectedBootIdentity) ||
    row.sid !== target.sid ||
    row.target !== target.identity ||
    row.release !== target.identity ||
    !Number.isSafeInteger(row.sequence) ||
    (row.sequence as number) < 1 ||
    row.modelSha256 !== MODEL.sha256 ||
    row.fixtureSha256 !== PREPARATION_FIXTURE.sha256 ||
    typeof row.manifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.manifestSha256) ||
    typeof row.activatedAt !== "string" ||
    !Number.isFinite(Date.parse(row.activatedAt))
  )
    throw new PrepareFailure("INTEGRITY_INVALID");
  const fingerprint = record(row.modelFingerprint);
  if (
    Object.keys(fingerprint).length !== 5 ||
    fingerprint.bytes !== MODEL.bytes ||
    [
      fingerprint.device,
      fingerprint.fileId,
      fingerprint.writtenAt,
      fingerprint.changedAt,
    ].some((part) => typeof part !== "string" || !/^\d{1,30}$/.test(part))
  )
    throw new PrepareFailure("INTEGRITY_INVALID");
  const evidence = parseQualificationEvidence(row.qualification, {
    runtimeProfile: "windows-user",
    expectedUserSid: target.sid,
    expectedFixtureDigest: PREPARATION_FIXTURE.sha256,
  });
  if (
    evidence.releaseManifestDigest !== row.manifestSha256 ||
    evidence.modelDigest !== MODEL.sha256 ||
    evidence.runtimeDiagnostics?.onnxRuntime !== "1.24.4"
  )
    throw new PrepareFailure("INTEGRITY_INVALID");
  return { receipt: row as unknown as ReadyReceipt, evidence };
}
async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return true;
    throw error;
  }
}

/** Production preparation: signed local archive, pinned model, real owned GPU child, then DPAPI activation. */
export class WindowsPreparationOperations implements PreparationOperations {
  private bundle: PreparationBundle | undefined;
  private unpackedBytes = 0;
  private qualification: QualificationResult | undefined;
  private preference: ConsumerGpuIdentity | undefined;
  private readonly runner: PreparationQualificationRunner;
  private readonly startup: StartupReadinessCache;
  private readonly staging: RuntimeStaging;
  private readonly runtimeRepair: RuntimeRepair;
  private readonly runtimeStatus: RuntimeStatusCache;
  private measurement: ReadinessMeasurement | undefined;
  private setupLease: PrepareLease | null = null;
  constructor(
    private readonly host: HostContext,
    private readonly resourcesRoot: string,
    private readonly browserRegistration: () => Promise<boolean>,
    private readonly bundleLoader?: (
      minimumSequence: number,
      existingReady?: ReadyReceipt,
    ) => Promise<PreparationBundle>,
    private readonly transfers: {
      fetch?: typeof fetch;
      measurements?: LocalStartupMeasurements;
      /** Mandatory for changing an existing canonical runtime; supplied by the trusted Main coordinator. */
      assertMutation?(target: PrepareTarget): Promise<void>;
    } = {},
  ) {
    this.runner = new PreparationQualificationRunner(host, (release) =>
      this.verifyRelease(release),
    );
    this.startup = new StartupReadinessCache({
      readMarker: () => host.native.vaultRead("account", "startup_receipt"),
      writeMarker: (bytes) =>
        host.native.vaultWrite("account", "startup_receipt", bytes),
      removeMarker: () => host.native.vaultDelete("account", "startup_receipt"),
      readCapsule: (path, maximum) => readPrivateBytes(host, path, maximum),
      writeCapsule: (path, bytes) => writePrivateAtomic(host, path, bytes),
      fingerprint: (path) => privateFingerprint(host, path),
      enumerateGpus: () => host.native.enumerateGpus(),
      bootIdentity: () => host.native.bootIdentity(),
    });
    this.runtimeStatus = new RuntimeStatusCache({
      readMarker: () => host.native.vaultRead("account", "runtime_status"),
      writeMarker: (bytes) =>
        host.native.vaultWrite("account", "runtime_status", bytes),
      readCapsule: (path, maximum) => readPrivateBytes(host, path, maximum),
      writeCapsule: (path, bytes) => writePrivateAtomic(host, path, bytes),
      fingerprint: (path) => privateFingerprint(host, path),
    });
    this.staging = new RuntimeStaging(host, async (record, relative) => {
      const bytes = await host.native.vaultRead(
        "account",
        `runtime_${record.target.slice(0, 56)}`,
      );
      if (!bytes) throw new PrepareFailure("INTEGRITY_INVALID");
      const proof = parseRuntimeProof(JSON.parse(bytes.toString("utf8")), {
        sid: host.identity.sid,
        release: record.target,
        archiveSha256: record.archiveSha256,
        sequence: record.sequence,
      });
      const verified = await this.verifyInventory(
        relative,
        record.releaseVersion,
      );
      if (
        verified.manifestSha256 !== record.manifestSha256 ||
        verified.manifestSha256 !== proof.manifestSha256
      )
        throw new PrepareFailure("INTEGRITY_INVALID");
    });
    this.runtimeRepair = new RuntimeRepair(
      host,
      (target) => this.assertMutation(target),
      async (rowPath, row) => {
        const bytes = await host.native.vaultRead(
          "account",
          `runtime_${row.target.slice(0, 56)}`,
        );
        if (!bytes) throw new PrepareFailure("INTEGRITY_INVALID");
        const proof = parseRuntimeProof(JSON.parse(bytes.toString("utf8")), {
          sid: host.identity.sid,
          release: row.target,
          archiveSha256: row.archiveSha256,
          sequence: row.sequence,
        });
        const verified = await this.verifyInventory(
          rowPath,
          row.releaseVersion,
        );
        if (
          verified.manifestSha256 !== row.manifestSha256 ||
          proof.manifestSha256 !== row.manifestSha256
        )
          throw new PrepareFailure("INTEGRITY_INVALID");
        return [
          "release-manifest.json",
          ...verified.manifest.entries.map((entry) => entry.path),
        ];
      },
    );
  }
  private relativeRelease(
    release = this.requireBundle().targetIdentity,
  ): string {
    return `runtime\\releases\\${release}`;
  }
  private requireBundle(): PreparationBundle {
    if (!this.bundle) throw new PrepareFailure("INTEGRITY_INVALID");
    return this.bundle;
  }
  private expectedProof(): {
    sid: string;
    release: string;
    archiveSha256: string;
    sequence: number;
  } {
    const bundle = this.requireBundle();
    return {
      sid: this.host.identity.sid,
      release: bundle.targetIdentity,
      archiveSha256: bundle.metadata.release.sha256,
      sequence: bundle.metadata.sequence,
    };
  }
  async target(signal: AbortSignal): Promise<PrepareTarget> {
    return this.selectTarget(signal, true);
  }
  private async selectTarget(
    signal: AbortSignal,
    qualifiedPreference: boolean,
  ): Promise<PrepareTarget> {
    signal.throwIfAborted();
    const saved = await this.host.native.vaultRead(
      "account",
      "runtime_sequence",
    );
    let minimum = 1;
    if (saved) {
      const value = record(JSON.parse(saved.toString("utf8")));
      if (
        value.version !== 1 ||
        Object.keys(value).length !== 2 ||
        !Number.isSafeInteger(value.sequence) ||
        (value.sequence as number) < 1
      )
        throw new PrepareFailure("INTEGRITY_INVALID");
      minimum = value.sequence as number;
    }
    let existing: ReadyReceipt | undefined;
    const active = await this.host.native.vaultRead("account", "ready_receipt");
    if (active) {
      try {
        const raw = record(JSON.parse(active.toString("utf8")));
        if (
          typeof raw.target !== "string" ||
          !/^[a-f0-9]{64}$/.test(raw.target)
        )
          throw new Error("INVALID_RECEIPT");
        // This proves only prior installation for the exact offline expiry
        // exception. A past boot never grants GPU readiness; receipt()/the
        // warm cache require the current witness and qualification reruns.
        existing = parseReadyReceipt(raw, {
          sid: this.host.identity.sid,
          identity: raw.target,
        }).receipt;
      } catch {
        /* A corrupt receipt can never authorize the offline expiry exception. */
      }
    }
    this.bundle = this.bundleLoader
      ? await this.bundleLoader(minimum, existing)
      : await loadPreparationBundle(
          this.resourcesRoot,
          minimum,
          new Date(),
          existing,
        );
    this.preference = undefined;
    if (
      qualifiedPreference &&
      existing &&
      existing.bootIdentity === (await this.host.native.bootIdentity())
    ) {
      this.preference = parseReadyReceipt(
        existing,
        { sid: this.host.identity.sid, identity: existing.target },
        existing.bootIdentity,
      ).evidence.gpuIdentity;
    }
    return {
      sid: this.host.identity.sid,
      identity: this.bundle.targetIdentity,
    };
  }
  private startupBinding(receipt: ReadyReceipt): ReadinessBinding {
    return {
      bootIdentity: receipt.bootIdentity,
      sid: this.host.identity.sid,
      installationId: this.host.report.installationId,
      target: receipt.target,
      sequence: receipt.sequence,
      manifestSha256: receipt.manifestSha256,
      modelSha256: MODEL.sha256,
      fixtureSha256: PREPARATION_FIXTURE.sha256,
      policy: "windows-user/directml/onnxruntime-1.24.4/no-cpu-v1",
    };
  }
  private runtimeStatusBinding(manifestSha256: string): RuntimeStatusBinding {
    return {
      sid: this.host.identity.sid,
      installationId: this.host.report.installationId,
      target: this.requireBundle().targetIdentity,
      sequence: this.requireBundle().metadata.sequence,
      manifestSha256,
      dllPolicy: CONSUMER_DLL_POLICY,
    };
  }
  private async captureRuntimeStatus(
    verified: { manifest: WindowsReleaseManifest; manifestSha256: string },
    signal: AbortSignal,
  ) {
    const prefix = this.relativeRelease();
    await this.runtimeStatus.capture(
      this.runtimeStatusBinding(verified.manifestSha256),
      [
        `${prefix}\\release-manifest.json`,
        ...verified.manifest.entries
          .filter((entry) => entry.kind === "file")
          .map((entry) => `${prefix}\\${entry.path.replaceAll("/", "\\")}`),
      ],
      signal,
    );
  }
  private async statusInventory(
    signal: AbortSignal,
    runtimeAlreadyChecked = false,
  ) {
    if (!this.bundle) await this.selectTarget(signal, false);
    signal.throwIfAborted();
    const bundle = this.requireBundle(),
      bytes = await this.host.native.vaultRead(
        "account",
        `runtime_${bundle.targetIdentity.slice(0, 56)}`,
      );
    if (!bytes) throw new PrepareFailure("INTEGRITY_INVALID");
    const proof = parseRuntimeProof(
      JSON.parse(bytes.toString("utf8")),
      this.expectedProof(),
    );
    if (
      !runtimeAlreadyChecked &&
      !(await this.runtimeStatus.check(
        this.runtimeStatusBinding(proof.manifestSha256),
        signal,
      ))
    )
      throw new PrepareFailure("INTEGRITY_INVALID");
    const raw = await readPrivateBytes(
      this.host,
      `${this.relativeRelease()}\\release-manifest.json`,
      16 * 1024 ** 2,
    );
    if (createHash("sha256").update(raw).digest("hex") !== proof.manifestSha256)
      throw new PrepareFailure("INTEGRITY_INVALID");
    const manifest = parseWindowsReleaseManifest(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
    );
    if (
      manifest.installationProfile !== "windows-user" ||
      manifest.releaseVersion !== bundle.metadata.releaseVersion
    )
      throw new PrepareFailure("INTEGRITY_INVALID");
    const helper = manifest.entries.find(
      (entry) =>
        entry.kind === "file" &&
        entry.path === "runtime/native/musicmute-native.exe",
    );
    if (helper?.kind !== "file") throw new PrepareFailure("INTEGRITY_INVALID");
    signal.throwIfAborted();
    return {
      manifest,
      manifestSha256: proof.manifestSha256,
      helperSha256: helper.sha256,
    };
  }
  startupMeasurement(): ReadinessMeasurement | null {
    return this.measurement ? { ...this.measurement } : null;
  }
  async cachedReady(
    target: PrepareTarget,
    signal: AbortSignal,
  ): Promise<boolean> {
    const phase = this.transfers.measurements?.begin("status-check");
    try {
      if (await this.runtimeRepair.blocksReady()) {
        phase?.failed();
        return false;
      }
      const receipt = await this.receipt();
      if (
        !receipt ||
        receipt.target !== target.identity ||
        receipt.sequence !== this.requireBundle().metadata.sequence
      ) {
        phase?.failed();
        return false;
      }
      const proofBytes = await this.host.native.vaultRead(
        "account",
        `runtime_${receipt.release.slice(0, 56)}`,
      );
      if (!proofBytes) {
        phase?.failed();
        return false;
      }
      const proof = parseRuntimeProof(
        JSON.parse(proofBytes.toString("utf8")),
        this.expectedProof(),
      );
      if (proof.manifestSha256 !== receipt.manifestSha256) {
        phase?.failed();
        return false;
      }
      this.measurement = await this.startup.check(
        this.startupBinding(receipt),
        signal,
      );
      if (this.measurement.ready) phase?.complete();
      else if (signal.aborted) phase?.cancelled();
      else phase?.failed();
      return this.measurement.ready;
    } catch {
      if (signal.aborted) phase?.cancelled();
      else phase?.failed();
      return false;
    } finally {
      await this.transfers.measurements?.flush().catch(() => {});
    }
  }
  async browserReady(
    _target: PrepareTarget,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted();
    const ready = await verifyBrowserIntegration(this.host, this.resourcesRoot);
    signal.throwIfAborted();
    return ready;
  }
  async finishCachedReady(
    target: PrepareTarget,
    signal: AbortSignal,
  ): Promise<void> {
    const bundle = this.requireBundle();
    if (
      target.sid !== this.host.identity.sid ||
      target.identity !== bundle.targetIdentity
    )
      throw new PrepareFailure("INTEGRITY_INVALID");
    await this.staging.recover();
    if (bundle.source)
      await removePreparationArchive(
        this.host,
        target.identity,
        bundle.metadata.release,
        signal,
      );
  }
  async lock(target: PrepareTarget): Promise<PrepareLease | null> {
    if (this.setupLease) return null;
    const actual = await this.host.prepareLease(target);
    if (!actual) return null;
    const lease = {
      release: async () => {
        await actual.release();
        if (this.setupLease === lease) this.setupLease = null;
      },
    };
    this.setupLease = lease;
    return lease;
  }
  private async assertMutation(target: PrepareTarget): Promise<void> {
    if (!this.setupLease || !this.transfers.assertMutation)
      throw new PrepareFailure("BUSY");
    await this.transfers.assertMutation(target);
    if (!this.setupLease) throw new PrepareFailure("BUSY");
  }
  async space(_target: PrepareTarget, signal: AbortSignal) {
    const bundle = this.requireBundle();
    if (bundle.source)
      this.unpackedBytes = bundle.source.unpackedBytes ?? MAX_UNPACKED_BYTES;
    else if (this.unpackedBytes === 0)
      this.unpackedBytes = await planVerifiedArchive(
        bundle.archivePath,
        bundle.metadata.release.bytes,
        bundle.metadata.release.sha256,
        signal,
      );
    const disk = await statfs(this.host.personalRoot, { bigint: true });
    const available = disk.bavail * disk.bsize;
    // Account for runtime, verified model plus its incomplete download, qualification scratch and headroom.
    const requiredBytes =
      this.unpackedBytes +
      (bundle.source ? bundle.metadata.release.bytes : 0) +
      MODEL.bytes * 2 +
      512 * 1024 ** 2;
    return {
      requiredBytes,
      availableBytes: Number(
        available > BigInt(Number.MAX_SAFE_INTEGER)
          ? BigInt(Number.MAX_SAFE_INTEGER)
          : available,
      ),
    };
  }
  private async receipt(): Promise<ReadyReceipt | null> {
    const bytes = await this.host.native.vaultRead("account", "ready_receipt");
    if (!bytes) return null;
    return parseReadyReceipt(
      JSON.parse(bytes.toString("utf8")),
      {
        sid: this.host.identity.sid,
        identity: this.requireBundle().targetIdentity,
      },
      await this.host.native.bootIdentity(),
    ).receipt;
  }
  private async verifyModel(signal: AbortSignal) {
    try {
      const result = await verifyPrivateFile(
        this.host,
        `models\\${MODEL.filename}`,
        MODEL.bytes,
        signal,
      );
      if (result.sha256 !== MODEL.sha256)
        throw new PrepareFailure("INTEGRITY_INVALID");
      return result;
    } catch (error) {
      throw new PrepareFailure(preparationFailure(error).code, "model");
    }
  }
  private async modelFingerprint() {
    try {
      const value = await privateFingerprint(
        this.host,
        `models\\${MODEL.filename}`,
      );
      if (value.bytes !== MODEL.bytes)
        throw new PrepareFailure("INTEGRITY_INVALID");
      return value;
    } catch (error) {
      throw new PrepareFailure(preparationFailure(error).code, "model");
    }
  }
  async snapshotReady(signal: AbortSignal) {
    signal.throwIfAborted();
    const receipt = await this.receipt();
    if (!receipt) throw new PrepareFailure("INTEGRITY_INVALID");
    const verified = await this.verifyRelease(receipt.release);
    const fingerprint = await this.modelFingerprint();
    if (verified.manifestSha256 !== receipt.manifestSha256)
      throw new PrepareFailure("INTEGRITY_INVALID");
    if (
      JSON.stringify(fingerprint) !== JSON.stringify(receipt.modelFingerprint)
    )
      throw new PrepareFailure("INTEGRITY_INVALID", "model");
    return this.readySnapshot(receipt, verified);
  }
  private readySnapshot(
    receipt: ReadyReceipt,
    verified: { manifestSha256: string; helperSha256: string },
  ) {
    return {
      bootIdentity: receipt.bootIdentity,
      release: receipt.release,
      archiveSha256: this.requireBundle().metadata.release.sha256,
      releaseVersion: this.requireBundle().metadata.releaseVersion,
      releaseRoot: win32.join(
        this.host.personalRoot,
        this.relativeRelease(receipt.release),
      ),
      modelRoot: win32.join(this.host.personalRoot, "models"),
      manifestSha256: verified.manifestSha256,
      nativeSha256: verified.helperSha256,
      modelSha256: receipt.modelSha256,
      modelFingerprint: receipt.modelFingerprint,
      qualification: receipt.qualification,
      evidence: parseReadyReceipt(receipt, {
        sid: this.host.identity.sid,
        identity: receipt.target,
      }).evidence,
    };
  }
  /** Warm controller status only; the caller must still run the full role
   * admission verifier before executing anything in this runtime. */
  async snapshotReadyStatus(signal: AbortSignal) {
    if (!this.bundle) await this.target(signal);
    const receipt = await this.receipt();
    if (
      !receipt ||
      !(await this.cachedReady(
        { sid: this.host.identity.sid, identity: receipt.target },
        signal,
      ))
    )
      throw new PrepareFailure("INTEGRITY_INVALID");
    const verified = await this.statusInventory(signal, true);
    const current = await this.receipt();
    if (
      !current ||
      JSON.stringify(current) !== JSON.stringify(receipt) ||
      verified.manifestSha256 !== receipt.manifestSha256
    )
      throw new PrepareFailure("INTEGRITY_INVALID");
    return this.readySnapshot(receipt, verified);
  }
  /** Caller holds the real Prepare/maintenance fence. Requalify existing signed bytes; no download, registration or activation. */
  async requalifyInstalled(
    signal: AbortSignal,
    selection?: TrustedPreparationGpuSelection,
  ): Promise<void> {
    signal.throwIfAborted();
    const bytes = await this.host.native.vaultRead("account", "ready_receipt");
    if (!bytes || bytes.length > 32768)
      throw new PrepareFailure("INTEGRITY_INVALID");
    let old: InstalledReadyMetadata;
    try {
      const raw = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      old = parseInstalledReadyMetadata(raw, this.host.identity.sid);
    } finally {
      bytes.fill(0);
    }
    const target = await this.target(signal);
    if (target.identity !== old.target || target.sid !== old.sid)
      throw new PrepareFailure("INTEGRITY_INVALID");
    const verified = await this.verifyRelease(old.release);
    if (verified.manifestSha256 !== old.manifestSha256)
      throw new PrepareFailure("INTEGRITY_INVALID");
    const before = await this.verifyModel(signal);
    if (before.sha256 !== old.modelSha256)
      throw new PrepareFailure("INTEGRITY_INVALID");
    const result = await this.runner.run(
      old.release,
      signal,
      undefined,
      selection,
    );
    signal.throwIfAborted();
    const model = await this.verifyModel(signal);
    if (
      result.bootIdentity !== (await this.host.native.bootIdentity()) ||
      model.sha256 !== old.modelSha256 ||
      JSON.stringify(model.fingerprint) !==
        JSON.stringify(before.fingerprint) ||
      result.evidence.releaseManifestDigest !== old.manifestSha256
    )
      throw new PrepareFailure("INTEGRITY_INVALID");
    const next: ReadyReceipt = {
      ...old,
      version: 2,
      bootIdentity: result.bootIdentity,
      modelFingerprint: model.fingerprint,
      qualification: result.raw,
    };
    parseReadyReceipt(
      next,
      { sid: this.host.identity.sid, identity: old.target },
      result.bootIdentity,
    );
    await this.startup.invalidate();
    await this.host.native.vaultWrite(
      "account",
      "ready_receipt",
      Buffer.from(JSON.stringify(next)),
    );
    await this.recaptureStartupReceipt(signal);
  }
  /** Refresh a capsule only when the installed receipt is already operational on the current witness. */
  async recaptureStartupReceipt(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const receipt = await this.receipt();
    if (!receipt) throw new PrepareFailure("INTEGRITY_INVALID");
    const verified = await this.verifyRelease(receipt.release),
      evidence = parseReadyReceipt(receipt, {
        sid: this.host.identity.sid,
        identity: receipt.target,
      }).evidence;
    if (
      verified.manifestSha256 !== receipt.manifestSha256 ||
      !evidence.gpuIdentity ||
      JSON.stringify(await this.modelFingerprint()) !==
        JSON.stringify(receipt.modelFingerprint)
    )
      throw new PrepareFailure("INTEGRITY_INVALID");
    const gpu = resolveQualifiedGpuIdentity(
      evidence.gpuIdentity,
      await this.host.native.enumerateGpus(),
    );
    const prefix = this.relativeRelease(receipt.release),
      paths = [
        `${prefix}\\release-manifest.json`,
        ...verified.manifest.entries
          .filter((entry) => entry.kind === "file")
          .map((entry) => `${prefix}\\${entry.path.replaceAll("/", "\\")}`),
        `models\\${MODEL.filename}`,
        `fixtures\\${PREPARATION_FIXTURE.filename}`,
      ];
    await this.startup.invalidate();
    await this.startup.capture(
      this.startupBinding(receipt),
      gpu,
      paths,
      signal,
    );
  }
  /** Account cloud upload preparation uses CPU media tools without local model/GPU qualification. */
  async snapshotMediaTools(signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.bundle) await this.selectTarget(signal, false);
    const release = this.requireBundle().targetIdentity;
    const verified = await this.verifyRelease(release);
    signal.throwIfAborted();
    return this.mediaToolsSnapshot(release, verified);
  }
  /** Runtime-only CPU tool status deliberately has no model/GPU prerequisite. */
  async snapshotMediaToolsStatus(signal: AbortSignal) {
    const verified = await this.statusInventory(signal);
    return this.mediaToolsSnapshot(
      this.requireBundle().targetIdentity,
      verified,
    );
  }
  private mediaToolsSnapshot(
    release: string,
    verified: { manifestSha256: string; helperSha256: string },
  ) {
    const releaseRoot = win32.join(
      this.host.personalRoot,
      this.relativeRelease(release),
    );
    return {
      releaseRoot,
      manifestSha256: verified.manifestSha256,
      nativeSha256: verified.helperSha256,
      ffmpegPath: win32.join(releaseRoot, "runtime", "bin", "ffmpeg.exe"),
      ffprobePath: win32.join(releaseRoot, "runtime", "bin", "ffprobe.exe"),
    };
  }
  async qualifyApprovedFixture(
    fixture: ApprovedPreparationFixture,
    signal: AbortSignal,
  ): Promise<QualificationResult> {
    assertApprovedPreparationFixture(fixture);
    const snapshot = await this.snapshotReady(signal);
    const lease = await this.host.prepareLease({
      sid: this.host.identity.sid,
      identity: snapshot.release,
    });
    if (!lease) throw new PrepareFailure("BUSY");
    try {
      if (
        (await hashPrivateFile(
          this.host,
          fixture.relativePath,
          fixture.bytes,
          signal,
        )) !== fixture.sha256
      )
        throw new PrepareFailure("INTEGRITY_INVALID");
      return await this.runner.run(snapshot.release, signal, fixture);
    } finally {
      await lease.release();
    }
  }
  private async verifyInventory(
    relative: string,
    releaseVersion = this.requireBundle().metadata.releaseVersion,
  ): Promise<{
    manifest: WindowsReleaseManifest;
    manifestSha256: string;
    helperSha256: string;
  }> {
    await this.host.native.validatePath("personal", relative, "directory");
    await this.host.native.validatePath(
      "personal",
      `${relative}\\release-manifest.json`,
      "file",
    );
    const root = win32.join(this.host.personalRoot, relative),
      manifest = await verifyWindowsRelease(root, "windows-user");
    if (manifest.releaseVersion !== releaseVersion)
      throw new PrepareFailure("INTEGRITY_INVALID");
    for (const entry of manifest.entries)
      await this.host.native.validatePath(
        "personal",
        `${relative}\\${entry.path.replaceAll("/", "\\")}`,
        entry.kind,
      );
    const manifestSha256 = createHash("sha256")
      .update(await readFile(win32.join(root, "release-manifest.json")))
      .digest("hex");
    const helper = manifest.entries.find(
      (entry) =>
        entry.kind === "file" &&
        entry.path === "runtime/native/musicmute-native.exe",
    );
    if (helper?.kind !== "file") throw new PrepareFailure("INTEGRITY_INVALID");
    return { manifest, manifestSha256, helperSha256: helper.sha256 };
  }
  private async verifyRelease(release: string) {
    if (release !== this.requireBundle().targetIdentity)
      throw new PrepareFailure("INTEGRITY_INVALID");
    const bytes = await this.host.native.vaultRead(
      "account",
      `runtime_${release.slice(0, 56)}`,
    );
    if (!bytes) throw new PrepareFailure("INTEGRITY_INVALID");
    const proof = parseRuntimeProof(
      JSON.parse(bytes.toString("utf8")),
      this.expectedProof(),
    );
    const verified = await this.verifyInventory(this.relativeRelease(release));
    if (verified.manifestSha256 !== proof.manifestSha256)
      throw new PrepareFailure("INTEGRITY_INVALID");
    return verified;
  }
  async reuse(
    stage: Parameters<PreparationOperations["reuse"]>[0],
    _target: PrepareTarget,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted();
    try {
      if (stage === "inspect" || stage === "space") return true;
      if (stage === "runtime") {
        await this.verifyRelease(this.requireBundle().targetIdentity);
        return true;
      }
      if (stage === "model")
        return (
          (await hashPrivateFile(
            this.host,
            `models\\${MODEL.filename}`,
            MODEL.bytes,
            signal,
          )) === MODEL.sha256 &&
          (await hashPrivateFile(
            this.host,
            `fixtures\\${PREPARATION_FIXTURE.filename}`,
            PREPARATION_FIXTURE.bytes,
            signal,
          )) === PREPARATION_FIXTURE.sha256
        );
      // GPU and activation are revalidated by the owned qualification child, never trusted from a past PASS.
      return false;
    } catch {
      return false;
    }
  }
  async perform(
    stage: Parameters<PreparationOperations["perform"]>[0],
    target: PrepareTarget,
    signal: AbortSignal,
    progress: (done: number, total: number) => void,
  ): Promise<void> {
    signal.throwIfAborted();
    const bundle = this.requireBundle();
    if (
      target.identity !== bundle.targetIdentity ||
      target.sid !== this.host.identity.sid
    )
      throw new PrepareFailure("INTEGRITY_INVALID");
    if (stage === "inspect" || stage === "space") return;
    if (stage === "runtime") {
      await this.runtimeRepair.recover(bundle);
      const repaired = await this.runtimeRepair.promotedRecord();
      if (repaired) await this.staging.acceptRepairPromotion(repaired);
      await this.staging.recover();
      const finalRelative = this.relativeRelease(),
        final = win32.join(this.host.personalRoot, finalRelative);
      let replacing = false,
        previousManifestSha256: string | null = null;
      if (!(await absent(final))) {
        let verified: Awaited<ReturnType<typeof this.verifyRelease>> | null =
          null;
        try {
          verified = await this.verifyRelease(bundle.targetIdentity);
        } catch {
          await this.assertMutation(target);
          replacing = true;
          const oldProof = await this.host.native.vaultRead(
            "account",
            `runtime_${bundle.targetIdentity.slice(0, 56)}`,
          );
          if (oldProof) {
            try {
              previousManifestSha256 = parseRuntimeProof(
                JSON.parse(oldProof.toString("utf8")),
                this.expectedProof(),
              ).manifestSha256;
            } catch {
              /* Unverified legacy/corrupt proof carries no old manifest authority. */
            }
          }
        }
        if (verified) {
          // A cache-write failure is not evidence of damaged runtime bytes.
          if (this.setupLease)
            await this.captureRuntimeStatus(verified, signal);
          return;
        }
      }
      if (bundle.source) {
        bundle.archivePath = await downloadPrivatePreparationArtifact({
          host: this.host,
          kind: "runtime",
          target: bundle.targetIdentity,
          pin: {
            url: bundle.source.url,
            bytes: bundle.metadata.release.bytes,
            sha256: bundle.metadata.release.sha256,
          },
          destination: `prepare\\downloads\\runtime-${bundle.targetIdentity}.zip`,
          signal,
          allowNetwork: bundle.allowNetwork ?? true,
          ...(bundle.source.allowedOrigins
            ? { runtimeOrigins: bundle.source.allowedOrigins }
            : {}),
          fetch: this.transfers.fetch ?? fetch,
          onProgress: progress,
        });
        const unpacked = await planVerifiedArchive(
          bundle.archivePath,
          bundle.metadata.release.bytes,
          bundle.metadata.release.sha256,
          signal,
        );
        if (
          bundle.source.unpackedBytes !== null &&
          unpacked !== bundle.source.unpackedBytes
        )
          throw new PrepareFailure("INTEGRITY_INVALID");
        this.unpackedBytes = unpacked;
      }
      await this.host.directory("runtime\\releases");
      const staging = RUNTIME_STAGING_PATH;
      const root = await this.staging.create(bundle);
      try {
        await extractVerifiedArchive({
          path: bundle.archivePath,
          expectedBytes: bundle.metadata.release.bytes,
          expectedSha256: bundle.metadata.release.sha256,
          destination: {
            root,
            directory: async (relative) =>
              this.host.directory(
                relative
                  ? `${staging}\\${relative.replaceAll("/", "\\")}`
                  : staging,
              ),
            validateFile: (relative, kind) =>
              this.host.native.validatePath(
                "personal",
                `${staging}\\${relative.replaceAll("/", "\\")}`,
                kind,
              ),
          },
          signal,
          onProgress: progress,
        });
        const verified = await this.verifyInventory(staging);
        try {
          await auditWindowsConsumerDlls(
            root,
            verified.manifest.entries
              .filter((entry) => entry.kind === "file")
              .map((entry) => win32.join(root, ...entry.path.split("/"))),
          );
        } catch {
          throw new PrepareFailure("INTEGRITY_INVALID");
        }
        signal.throwIfAborted();
        const proof: RuntimeProof = {
          version: 2,
          dllPolicy: CONSUMER_DLL_POLICY,
          ...this.expectedProof(),
          manifestSha256: verified.manifestSha256,
        };
        await this.staging.verified(verified.manifestSha256);
        if (replacing) {
          await this.assertMutation(target);
          await this.startup.invalidate();
          await this.host.native.vaultDelete("account", "ready_receipt");
        }
        // Persist proof before rename: a crash after rename can resume this exact signed inventory.
        await this.host.native.vaultWrite(
          "account",
          `runtime_${bundle.targetIdentity.slice(0, 56)}`,
          Buffer.from(JSON.stringify(proof)),
        );
        signal.throwIfAborted();
        if (replacing)
          await this.runtimeRepair.replace(
            bundle,
            this.staging.verifiedRecord(),
            previousManifestSha256,
          );
        else await this.staging.promote();
        const published = await this.verifyRelease(bundle.targetIdentity);
        await this.staging.complete();
        await this.captureRuntimeStatus(published, signal);
      } catch (error) {
        if (!this.runtimeRepair.cleanupPending())
          await this.staging.discardOwned();
        throw error;
      }
      return;
    }
    if (stage === "model") {
      try {
        let validModel = false;
        try {
          validModel =
            (await hashPrivateFile(
              this.host,
              `models\\${MODEL.filename}`,
              MODEL.bytes,
              signal,
            )) === MODEL.sha256;
        } catch {
          /* Only a verified model is reusable. */
        }
        if (!validModel) {
          const temporary = `models\\${MODEL.filename}.verified`;
          await downloadPrivatePreparationArtifact({
            host: this.host,
            kind: "model",
            target: bundle.targetIdentity,
            pin: MODEL,
            destination: temporary,
            signal,
            allowNetwork: bundle.allowNetwork ?? true,
            fetch: this.transfers.fetch ?? fetch,
            onProgress: progress,
          });
          signal.throwIfAborted();
          const model = `models\\${MODEL.filename}`,
            path = win32.join(this.host.personalRoot, model);
          if (!(await absent(path)))
            await this.host.native.validatePath("personal", model, "file");
          else await this.host.native.validatePath("personal", model, "absent");
          await rename(win32.join(this.host.personalRoot, temporary), path);
          if (
            (await hashPrivateFile(this.host, model, MODEL.bytes, signal)) !==
            MODEL.sha256
          )
            throw new PrepareFailure("INTEGRITY_INVALID");
        }
      } catch (error) {
        throw new PrepareFailure(preparationFailure(error).code, "model");
      }
      await writePrivateAtomic(
        this.host,
        `fixtures\\${PREPARATION_FIXTURE.filename}`,
        preparationFixture(),
      );
      return;
    }
    if (stage === "gpu") {
      await this.verifyModel(signal);
      this.qualification = await this.runner.run(
        bundle.targetIdentity,
        signal,
        undefined,
        undefined,
        this.preference,
      );
      return;
    }
    if (!this.qualification) throw new PrepareFailure("GPU_UNSUPPORTED");
    if (
      (await this.host.native.bootIdentity()) !==
      this.qualification.bootIdentity
    )
      throw new PrepareFailure("GPU_UNSUPPORTED");
    const verified = await this.verifyRelease(bundle.targetIdentity);
    await this.captureRuntimeStatus(verified, signal);
    const model = await this.verifyModel(signal);
    if (
      model.sha256 !== MODEL.sha256 ||
      this.qualification.evidence.releaseManifestDigest !==
        verified.manifestSha256
    )
      throw new PrepareFailure("INTEGRITY_INVALID");
    const receipt: ReadyReceipt = {
      version: 2,
      bootIdentity: this.qualification.bootIdentity,
      sid: target.sid,
      target: target.identity,
      release: target.identity,
      sequence: bundle.metadata.sequence,
      manifestSha256: verified.manifestSha256,
      modelSha256: MODEL.sha256,
      fixtureSha256: PREPARATION_FIXTURE.sha256,
      modelFingerprint: model.fingerprint,
      qualification: this.qualification.raw,
      activatedAt: new Date().toISOString(),
    };
    parseReadyReceipt(receipt, target);
    signal.throwIfAborted();
    const bytes = Buffer.from(JSON.stringify(receipt));
    if (bytes.length > 16384) throw new PrepareFailure("INTEGRITY_INVALID");
    await this.host.native.vaultWrite("account", "ready_receipt", bytes);
    await this.host.native.vaultWrite(
      "account",
      "runtime_sequence",
      Buffer.from(
        JSON.stringify({ version: 1, sequence: bundle.metadata.sequence }),
      ),
    );
    await this.runtimeRepair.activated(bundle);
    await this.runtimeRepair.cleanupBackup(bundle);
    // Remove only the private downloaded archive after durable activation; packaged resources stay untouched.
    if (bundle.source)
      await removePreparationArchive(
        this.host,
        bundle.targetIdentity,
        bundle.metadata.release,
        signal,
      );
    await this.startup.invalidate();
    if (this.qualification.evidence.gpuIdentity) {
      try {
        const prefix = this.relativeRelease(bundle.targetIdentity);
        const paths = [
          `${prefix}\\release-manifest.json`,
          ...verified.manifest.entries
            .filter((entry) => entry.kind === "file")
            .map((entry) => `${prefix}\\${entry.path.replaceAll("/", "\\")}`),
          `models\\${MODEL.filename}`,
          `fixtures\\${PREPARATION_FIXTURE.filename}`,
        ];
        await this.startup.capture(
          this.startupBinding(receipt),
          this.qualification.evidence.gpuIdentity,
          paths,
          signal,
        );
      } catch {
        signal.throwIfAborted();
        // Large/unsupported filesystems use full verification on next launch. Cache failure is never a PASS.
        this.measurement = {
          ready: false,
          reason: "changed",
          filesChecked: 0,
          durationMs: 0,
        };
      }
    }
  }
  async verifyReady(
    target: PrepareTarget,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted();
    const receipt = await this.receipt();
    if (
      !receipt ||
      receipt.target !== target.identity ||
      receipt.sid !== target.sid ||
      !this.qualification
    )
      return false;
    const verified = await this.verifyRelease(receipt.release);
    if (
      verified.manifestSha256 !== receipt.manifestSha256 ||
      JSON.stringify(await this.modelFingerprint()) !==
        JSON.stringify(receipt.modelFingerprint) ||
      (await hashPrivateFile(
        this.host,
        `fixtures\\${PREPARATION_FIXTURE.filename}`,
        PREPARATION_FIXTURE.bytes,
        signal,
      )) !== PREPARATION_FIXTURE.sha256
    )
      return false;
    return (
      JSON.stringify(
        parseQualificationEvidence(receipt.qualification, {
          runtimeProfile: "windows-user",
          expectedUserSid: target.sid,
          expectedFixtureDigest: PREPARATION_FIXTURE.sha256,
        }),
      ) === JSON.stringify(this.qualification.evidence)
    );
  }
  async registerBrowser(
    _target: PrepareTarget,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted();
    return this.browserRegistration();
  }
  async cancelOwned(): Promise<void> {
    await this.runner.cancel();
    if (await this.runtimeRepair.cancelBeforeEffects())
      await this.staging.discardOwned();
  }
  cleanupPending(): boolean {
    return this.runner.cleanupPending() || this.runtimeRepair.cleanupPending();
  }
  async recoverCleanup(): Promise<void> {
    await this.runner.recoverCleanup();
    if (this.runtimeRepair.cleanupPending()) {
      await this.runtimeRepair.recover(this.requireBundle());
      const repaired = await this.runtimeRepair.promotedRecord();
      if (repaired) await this.staging.acceptRepairPromotion(repaired);
    }
  }
  async cancelCleanup(): Promise<void> {
    await this.runner.recoverCleanup();
    if (await this.runtimeRepair.cancelBeforeEffects())
      await this.staging.discardOwned();
    else if (this.runtimeRepair.cleanupPending()) await this.recoverCleanup();
  }
  async repair(
    _target: PrepareTarget,
    _previous: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    await this.runner.cancel();
    await this.runtimeRepair.recover(this.requireBundle());
    const repaired = await this.runtimeRepair.promotedRecord();
    if (repaired) await this.staging.acceptRepairPromotion(repaired);
    await this.staging.discardOwned();
    await this.staging.recover();
    await this.startup.invalidate();
    // Repair reruns verification/qualification; preserve active runtimes, user media and both identities.
    this.qualification = undefined;
  }
}
