import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { win32 } from "node:path";
import {
  parseQualificationEvidence,
  resolveQualifiedGpuIdentity,
} from "../../../../worker/src/enrollment/report-builder.js";
import {
  sameConsumerProcess,
  type ConsumerMutexLease,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import type { HostContext } from "../host-context.js";
import type { WindowsPreparationOperations } from "../prepare/operations.js";
import {
  PreparationQualificationRunner,
  selectTrustedPreparationGpu,
  assertApprovedPreparationFixture,
  type ApprovedPreparationFixture,
  type QualificationResult,
  type TrustedPreparationGpuSelection,
} from "../prepare/qualification-runner.js";
import { hashPrivateFile, readPrivateBytes } from "../prepare/private-files.js";
import { fleetRecordAuthority, VaultFleetStore } from "./store.js";
import {
  parseFleetActiveRuntime,
  readOperationalFleetIdentity,
  readApprovedFleetGpuSelection,
  fleetGpuReadyAligned,
  type FleetActiveRuntimeProof,
} from "./active-runtime.js";

/** Called only under the updater's actual current-user Prepare lease and drained session fence. */
export async function refreshApprovedFleetRuntime(
  options: {
    host: HostContext;
    operations: Pick<
      WindowsPreparationOperations,
      "snapshotReady" | "requalifyInstalled"
    >;
    prepareLease: ConsumerMutexLease;
    transaction: string;
    runtimeIdentity: string;
    qualify?: (
      release: string,
      fixture: ApprovedPreparationFixture,
      signal: AbortSignal,
      selection: TrustedPreparationGpuSelection,
    ) => Promise<QualificationResult>;
    readFixture?: (
      digest: string,
      signal: AbortSignal,
    ) => Promise<ApprovedPreparationFixture>;
    readOriginalQualification?: (relative: string) => Promise<unknown>;
  },
  signal: AbortSignal,
): Promise<FleetActiveRuntimeProof | null> {
  const { host, operations, prepareLease } = options;
  if (
    prepareLease.scope !== "prepare" ||
    !sameConsumerProcess(prepareLease.identity, host.identity) ||
    !/^[a-f0-9]{64}$/u.test(prepareLease.nonce)
  )
    throw new Error("UPDATE_MAINTENANCE_REQUIRED");
  signal.throwIfAborted();
  const store = new VaultFleetStore(host.native, host.identity.sid),
    record = await store.read();
  if (!record || record.phase !== "complete") return null;
  const ready = await operations.snapshotReady(signal),
    expected = {
      release: ready.release,
      manifestDigest: ready.manifestSha256,
      archiveDigest: ready.archiveSha256,
      modelDigest: ready.modelSha256,
    };
  let operational: Awaited<
    ReturnType<typeof readOperationalFleetIdentity>
  > | null = null;
  try {
    operational = await readOperationalFleetIdentity(
      host.native,
      record,
      expected,
    );
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "FLEET_PREPARE_REQUIRED")
      throw error;
  }
  const selection = await readApprovedFleetGpuSelection(
      host.native,
      record,
      ready.bootIdentity,
    ),
    selected = selectTrustedPreparationGpu(
      selection,
      ready.bootIdentity,
      await host.native.enumerateGpus(),
    );
  if (
    !fleetGpuReadyAligned(ready, {
      bootIdentity: ready.bootIdentity,
      gpu: selected,
    })
  ) {
    await operations.requalifyInstalled(signal, selection);
    const aligned = await operations.snapshotReady(signal);
    if (
      aligned.release !== ready.release ||
      aligned.manifestSha256 !== ready.manifestSha256 ||
      aligned.modelSha256 !== ready.modelSha256 ||
      !fleetGpuReadyAligned(aligned, {
        bootIdentity: ready.bootIdentity,
        gpu: selected,
      })
    )
      throw new Error("FLEET_PREPARE_REQUIRED");
  }
  if (operational) {
    await readOperationalFleetIdentity(host.native, record, expected);
    return null; // Already-approved fleet proof remains current; only PERSONAL needed genuine alignment.
  }
  const relative = `prepare\\approved\\${record.prepared.fixtureDigest}.wav`;
  let fixture: ApprovedPreparationFixture;
  if (options.readFixture)
    fixture = await options.readFixture(record.prepared.fixtureDigest, signal);
  else {
    await host.native.validatePath("personal", relative, "file");
    const fixtureStat = await lstat(win32.join(host.personalRoot, relative));
    if (
      !fixtureStat.isFile() ||
      fixtureStat.isSymbolicLink() ||
      fixtureStat.nlink !== 1 ||
      fixtureStat.size < 44 ||
      fixtureStat.size > 64 * 1024 ** 2 ||
      (await hashPrivateFile(host, relative, fixtureStat.size, signal)) !==
        record.prepared.fixtureDigest
    )
      throw new Error("UPDATE_FLEET_FIXTURE_UNAVAILABLE");
    fixture = {
      relativePath: relative,
      sha256: record.prepared.fixtureDigest,
      bytes: fixtureStat.size,
    };
  }
  assertApprovedPreparationFixture(fixture);
  if (fixture.sha256 !== record.prepared.fixtureDigest)
    throw new Error("UPDATE_FLEET_FIXTURE_UNAVAILABLE");
  const qualificationRelative = `prepare\\approved\\qualification-${createHash("sha256").update(record.requests.report).digest("hex")}.json`;
  if (
    record.prepared.qualificationPath?.toLowerCase() !==
    win32.join(host.personalRoot, qualificationRelative).toLowerCase()
  )
    throw new Error("FLEET_INTEGRITY_INVALID");
  const original = parseQualificationEvidence(
    options.readOriginalQualification
      ? await options.readOriginalQualification(qualificationRelative)
      : JSON.parse(
          (await readPrivateBytes(host, qualificationRelative, 16384)).toString(
            "utf8",
          ),
        ),
    {
      runtimeProfile: "windows-user",
      expectedUserSid: host.identity.sid,
      expectedFixtureDigest: record.prepared.fixtureDigest,
    },
  );
  if (
    original.releaseManifestDigest !== record.prepared.manifestDigest ||
    original.modelDigest !== record.prepared.modelDigest
  )
    throw new Error("FLEET_INTEGRITY_INVALID");
  const runner = new PreparationQualificationRunner(host, async (release) => {
    const snapshot = await operations.snapshotReady(signal);
    if (
      release !== snapshot.release ||
      snapshot.manifestSha256 !== ready.manifestSha256 ||
      snapshot.modelSha256 !== ready.modelSha256
    )
      throw new Error("UPDATE_RUNTIME_CHANGED");
    return {
      manifestSha256: snapshot.manifestSha256,
      helperSha256: snapshot.nativeSha256,
    };
  });
  // The updater already holds Prepare. Taking a second helper's mutex here would deadlock.
  const result = await (options.qualify?.(
    ready.release,
    fixture,
    signal,
    selection,
  ) ?? runner.run(ready.release, signal, fixture, selection));
  signal.throwIfAborted();
  if (
    result.bootIdentity !== ready.bootIdentity ||
    result.bootIdentity !== (await host.native.bootIdentity())
  )
    throw new Error("FLEET_PREPARE_REQUIRED");
  if (
    !result.evidence.gpuIdentity ||
    (!selection.allowLuidRebind &&
      result.evidence.gpuIdentity.luid !== selection.approvedGpu.luid)
  )
    throw new Error("FLEET_ACTIVE_RUNTIME_INVALID");
  resolveQualifiedGpuIdentity(selected, [result.evidence.gpuIdentity]);
  const proof = parseFleetActiveRuntime(
    {
      version: 2,
      bootIdentity: result.bootIdentity,
      sid: host.identity.sid,
      authority: fleetRecordAuthority(record),
      transaction: options.transaction,
      updateIdentity: options.runtimeIdentity,
      ...expected,
      fixtureDigest: record.prepared.fixtureDigest,
      approvedRecipeDigests: Object.fromEntries(
        record.prepared.report.capabilities[0]!.recipeIds.map((recipe) => [
          recipe,
          original.recipeDigests[recipe],
        ]),
      ),
      qualification: result.raw,
      qualifiedAt: new Date().toISOString(),
    },
    record,
  );
  const recheck = await operations.snapshotReady(signal);
  if (
    recheck.release !== ready.release ||
    recheck.manifestSha256 !== ready.manifestSha256 ||
    recheck.modelSha256 !== ready.modelSha256 ||
    recheck.bootIdentity !== ready.bootIdentity
  )
    throw new Error("UPDATE_RUNTIME_CHANGED");
  const lock = await host.native.acquireMutex("cache");
  if (!lock) throw new Error("UPDATE_BUSY");
  try {
    const current = await store.read();
    if (
      !current ||
      current.phase !== "complete" ||
      fleetRecordAuthority(current) !== proof.authority
    )
      throw new Error("UPDATE_FLEET_CHANGED");
    signal.throwIfAborted();
    resolveQualifiedGpuIdentity(
      result.evidence.gpuIdentity!,
      await host.native.enumerateGpus(),
    );
    if ((await host.native.bootIdentity()) !== proof.bootIdentity)
      throw new Error("FLEET_PREPARE_REQUIRED");
    // Invalidate capacity before publishing; a crash can only reduce to the original single slot.
    await host.native.vaultDelete("fleet", "capacity");
    await host.native.vaultWrite(
      "fleet",
      "active_runtime",
      Buffer.from(JSON.stringify(proof)),
    );
  } finally {
    await host.native.releaseMutex(lock);
  }
  return proof;
}
/** Compatible update entry; approved runtime requalification also works independently of an app update. */
export function refreshFleetAfterConsumerUpdate(
  options: Omit<
    Parameters<typeof refreshApprovedFleetRuntime>[0],
    "runtimeIdentity"
  > & { updateIdentity: string },
  signal: AbortSignal,
) {
  const { updateIdentity, ...remaining } = options;
  return refreshApprovedFleetRuntime(
    { ...remaining, runtimeIdentity: updateIdentity },
    signal,
  );
}
