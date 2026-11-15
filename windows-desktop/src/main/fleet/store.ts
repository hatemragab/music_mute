import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  isCurrentUserSid,
  type WindowsConsumerNative,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import {
  assertInstallationReport,
  type WorkerInstallationReport,
} from "../../../../worker/src/enrollment/enrollment-client.js";
import {
  parseDirectmlGpuIdentity,
  type DirectmlGpuIdentity,
} from "../../../../worker/src/enrollment/report-builder.js";
import {
  storePreparationTarget,
  type StorePreparationBinding,
} from "../prepare/store-model-ready.js";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const SHA = /^[a-f0-9]{64}$/u;
function hasControls(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  });
}
const SECRET = /^[A-Za-z0-9_-]{43}$/u;
interface FleetPreparedCommon {
  /** Local witness only; legacy immutable approvals remain readable but need requalification. */
  bootIdentity?: string;
  release: string;
  manifestDigest: string;
  modelDigest: string;
  fixtureDigest: string;
  gpu: DirectmlGpuIdentity;
  qualificationPath: string | null;
  output: { path: string; bytes: number; sha256: string };
  report: WorkerInstallationReport;
}
export interface LegacyFleetPreparedIdentity extends FleetPreparedCommon {
  archiveDigest: string;
  distribution?: never;
  storeBinding?: never;
}
export interface StoreFleetPreparedIdentity extends FleetPreparedCommon {
  readonly distribution: "microsoft-store";
  readonly archiveDigest: null;
  readonly storeBinding: StorePreparationBinding;
}
/** Local observations only. Reading this record never creates package/code,
 * model/GPU authority or backend approval. Store callers revalidate live owners. */
export type FleetPreparedIdentity =
  LegacyFleetPreparedIdentity | StoreFleetPreparedIdentity;
export interface FleetEnrollmentRecord {
  /** Only first-onboarding policy; never a saved runtime intent authority. */
  startAfterEnrollment?: boolean;
  version: 1;
  sid: string;
  ownerUid: string;
  backendOrigin: string;
  label: string;
  onboardingRevision: number;
  phase:
    | "invitation"
    | "exchanged"
    | "qualified"
    | "uploaded"
    | "reported"
    | "activated"
    | "complete"
    | "revoked";
  prepared: FleetPreparedIdentity;
  requests: {
    exchange: string;
    upload: string;
    confirm: string;
    report: string;
    activate: string;
  };
  enrollmentCredential: string | null;
  invitationExpiresAt: string;
  installationId: string | null;
  installationCredential: string | null;
  machineCredential: string | null;
  /** Stable noncredential authority retained only after confirmed revocation. */
  retiredAuthority?: string;
  workerId: string;
  reportRevision: number | null;
  machineId: string | null;
  credentialRevision: number | null;
}
export interface FleetStorePort {
  read(): Promise<FleetEnrollmentRecord | null>;
  write(record: FleetEnrollmentRecord): Promise<void>;
  readPurgedTombstone?(): Promise<FleetPurgedTombstone | null>;
  renewInvitationIfCurrent?(
    expected: FleetEnrollmentRecord,
    replacement: FleetEnrollmentRecord,
  ): Promise<FleetEnrollmentRecord>;
  rememberUnpairAndRetire?(
    expectedAuthority: string,
    confirmation: { machineId: string; revision: number; confirmedAt: string },
  ): Promise<FleetEnrollmentRecord>;
}
export interface FleetPurgedTombstone {
  version: 1;
  sid: string;
  machineId: string;
  workerId: string;
  onboardingRevision: number;
  authority: string;
  purgedAt: string;
}
export function parseFleetPurgedTombstone(
  value: unknown,
  sid: string,
): FleetPurgedTombstone {
  const row = value as FleetPurgedTombstone;
  if (
    !row ||
    Object.keys(row).sort().join() !==
      "authority,machineId,onboardingRevision,purgedAt,sid,version,workerId" ||
    row.version !== 1 ||
    row.sid !== sid ||
    !isCurrentUserSid(row.sid) ||
    !UUID.test(row.machineId) ||
    !UUID.test(row.workerId) ||
    !SHA.test(row.authority) ||
    !Number.isSafeInteger(row.onboardingRevision) ||
    row.onboardingRevision < 1 ||
    !Number.isFinite(Date.parse(row.purgedAt))
  )
    throw new Error("FLEET_STATE_CORRUPT");
  return structuredClone(row);
}
/** Stable local authority: phase changes do not disguise a replaced credential. */
export function fleetRecordAuthority(record: FleetEnrollmentRecord): string {
  if (record.phase === "revoked" && record.retiredAuthority)
    return record.retiredAuthority;
  return createHash("sha256")
    .update(
      JSON.stringify([
        record.sid,
        record.machineId,
        record.workerId,
        record.machineCredential,
        record.credentialRevision,
        record.onboardingRevision,
        record.prepared.release,
        record.prepared.manifestDigest,
      ]),
    )
    .digest("hex");
}
export function parseFleetRecord(
  value: unknown,
  sid: string,
  origin?: string,
): FleetEnrollmentRecord {
  const fail = (): never => {
    throw new Error("FLEET_STATE_CORRUPT");
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  const row = value as Record<string, unknown>;
  const keys = [
    ...(row.startAfterEnrollment === undefined ? [] : ["startAfterEnrollment"]),
    "version",
    "sid",
    "ownerUid",
    "backendOrigin",
    "label",
    "onboardingRevision",
    "phase",
    "prepared",
    "requests",
    "enrollmentCredential",
    "invitationExpiresAt",
    "installationId",
    "installationCredential",
    "machineCredential",
    "workerId",
    "reportRevision",
    "machineId",
    "credentialRevision",
    ...(row.retiredAuthority === undefined ? [] : ["retiredAuthority"]),
  ];
  if (
    row.startAfterEnrollment !== undefined &&
    typeof row.startAfterEnrollment !== "boolean"
  )
    return fail();
  if (
    Object.keys(row).length !== keys.length ||
    Object.keys(row).some((key) => !keys.includes(key)) ||
    row.version !== 1 ||
    !isCurrentUserSid(row.sid) ||
    row.sid !== sid ||
    typeof row.ownerUid !== "string" ||
    row.ownerUid.length < 1 ||
    row.ownerUid.length > 128 ||
    typeof row.label !== "string" ||
    row.label.length < 1 ||
    row.label.length > 120 ||
    hasControls(row.label) ||
    !Number.isSafeInteger(row.onboardingRevision) ||
    (row.onboardingRevision as number) < 0 ||
    ![
      "invitation",
      "exchanged",
      "qualified",
      "uploaded",
      "reported",
      "activated",
      "complete",
      "revoked",
    ].includes(String(row.phase)) ||
    typeof row.backendOrigin !== "string"
  )
    return fail();
  try {
    const url = new URL(row.backendOrigin);
    if (
      url.protocol !== "https:" ||
      url.origin !== row.backendOrigin ||
      url.username ||
      url.password ||
      (origin && origin !== row.backendOrigin)
    )
      return fail();
  } catch {
    return fail();
  }
  const retired =
    row.phase === "revoked" &&
    typeof row.retiredAuthority === "string" &&
    SHA.test(row.retiredAuthority) &&
    row.enrollmentCredential === null &&
    row.installationCredential === null &&
    row.machineCredential === null;
  if (row.retiredAuthority !== undefined && !retired) return fail();
  if (
    (!retired &&
      ![row.enrollmentCredential, row.machineCredential].every(
        (v) => typeof v === "string" && SECRET.test(v),
      )) ||
    typeof row.workerId !== "string" ||
    !UUID.test(row.workerId) ||
    typeof row.invitationExpiresAt !== "string" ||
    !Number.isFinite(Date.parse(row.invitationExpiresAt))
  )
    return fail();
  const requests = row.requests as Record<string, unknown>;
  if (
    !requests ||
    Object.keys(requests).length !== 5 ||
    ["exchange", "upload", "confirm", "report", "activate"].some(
      (k) =>
        typeof requests[k] !== "string" || !UUID.test(requests[k] as string),
    ) ||
    new Set(Object.values(requests)).size !== 5
  )
    return fail();
  const p = row.prepared as Record<string, unknown>;
  const store = p?.distribution === "microsoft-store";
  if (
    !p ||
    Object.keys(p).filter((key) => key !== "bootIdentity").length !==
      (store ? 11 : 9) ||
    (!store &&
      (p.distribution !== undefined || p.storeBinding !== undefined)) ||
    (p.bootIdentity !== undefined &&
      (typeof p.bootIdentity !== "string" || !SHA.test(p.bootIdentity))) ||
    typeof p.release !== "string" ||
    !SHA.test(p.release) ||
    [p.manifestDigest, p.modelDigest, p.fixtureDigest].some(
      (v) => typeof v !== "string" || !SHA.test(v),
    ) ||
    (store
      ? p.archiveDigest !== null
      : typeof p.archiveDigest !== "string" || !SHA.test(p.archiveDigest)) ||
    (p.qualificationPath !== null &&
      (typeof p.qualificationPath !== "string" ||
        p.qualificationPath.length > 4096 ||
        hasControls(p.qualificationPath)))
  )
    return fail();
  if (store) {
    try {
      const binding = p.storeBinding as StorePreparationBinding;
      storePreparationTarget(binding);
      if (
        binding.sid !== sid ||
        p.release !== binding.inventorySha256 ||
        p.manifestDigest !== binding.runtimeManifestSha256 ||
        p.bootIdentity !== binding.bootIdentity ||
        p.modelDigest !== MODEL.sha256
      )
        return fail();
    } catch {
      return fail();
    }
  }
  const output = p.output as Record<string, unknown>;
  if (
    !output ||
    Object.keys(output).length !== 3 ||
    typeof output.path !== "string" ||
    output.path.length > 4096 ||
    hasControls(output.path) ||
    !Number.isSafeInteger(output.bytes) ||
    (output.bytes as number) < 1 ||
    (output.bytes as number) > 30_000_000 ||
    typeof output.sha256 !== "string" ||
    !SHA.test(output.sha256)
  )
    return fail();
  try {
    parseDirectmlGpuIdentity(p.gpu);
    assertInstallationReport(p.report as WorkerInstallationReport);
  } catch {
    return fail();
  }
  const report = p.report as WorkerInstallationReport;
  if (
    report.runtime.installationProfile !== "windows-user" ||
    report.runtime.manifestDigest !== p.manifestDigest ||
    report.runtime.modelDigest !== p.modelDigest ||
    report.capabilities.length !== 1 ||
    report.capabilities[0]?.platform !== "windows-amd64" ||
    report.capabilities[0]?.provider !== "directml" ||
    report.capabilities[0]?.maxSlots !== 1 ||
    report.label !== row.label
  )
    return fail();
  const gpu = p.gpu as DirectmlGpuIdentity;
  const reportedGpu = report.hardware.gpus.find(
    (candidate) => candidate.id === report.capabilities[0]!.gpuId,
  );
  const buildMatch = /^(?:10\.0\.)?(\d{5})(?:\.\d+)?$/.exec(
    report.hardware.osBuild,
  );
  if (
    !buildMatch ||
    Number(buildMatch[1]) < 19045 ||
    !reportedGpu ||
    reportedGpu.id !== `dxgi-${gpu.luid}` ||
    reportedGpu.name !== gpu.name ||
    reportedGpu.driverVersion !== gpu.driverVersion
  )
    return fail();
  const phases = [
    "invitation",
    "exchanged",
    "qualified",
    "uploaded",
    "reported",
    "activated",
    "complete",
    "revoked",
  ];
  const rank = phases.indexOf(String(row.phase));
  if (
    (rank >= 2 &&
      (typeof p.qualificationPath !== "string" ||
        p.qualificationPath.length < 1)) ||
    (rank >= 1
      ? typeof row.installationId !== "string" ||
        !UUID.test(row.installationId) ||
        (!retired &&
          (typeof row.installationCredential !== "string" ||
            !SECRET.test(row.installationCredential)))
      : row.installationId !== null || row.installationCredential !== null) ||
    (rank >= 4
      ? !Number.isSafeInteger(row.reportRevision) ||
        (row.reportRevision as number) < 1
      : row.reportRevision !== null) ||
    (rank >= 5
      ? typeof row.machineId !== "string" ||
        !UUID.test(row.machineId) ||
        !Number.isSafeInteger(row.credentialRevision) ||
        (row.credentialRevision as number) < 1
      : row.machineId !== null || row.credentialRevision !== null)
  )
    return fail();
  return structuredClone(row) as unknown as FleetEnrollmentRecord;
}
/** Current-user DPAPI record; credentials never use the app account namespace. */
export class VaultFleetStore implements FleetStorePort {
  constructor(
    private readonly native: Pick<
      WindowsConsumerNative,
      "vaultRead" | "vaultWrite" | "acquireMutex" | "releaseMutex"
    > &
      Partial<Pick<WindowsConsumerNative, "vaultDelete">>,
    private readonly sid: string,
    private readonly origin?: string,
    private readonly now: () => number = Date.now,
  ) {}
  async read(): Promise<FleetEnrollmentRecord | null> {
    const bytes = await this.native.vaultRead("fleet", "enrollment");
    if (!bytes) return null;
    if (bytes.length > 16384) throw new Error("FLEET_STATE_CORRUPT");
    try {
      return parseFleetRecord(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        this.sid,
        this.origin,
      );
    } catch {
      throw new Error("FLEET_STATE_CORRUPT");
    }
  }
  async write(record: FleetEnrollmentRecord): Promise<void> {
    const safe = parseFleetRecord(record, this.sid, this.origin),
      bytes = Buffer.from(JSON.stringify(safe));
    if (bytes.length > 16384) throw new Error("FLEET_STATE_CORRUPT");
    const lease = await this.native.acquireMutex("cache");
    if (!lease) throw new Error("FLEET_BUSY");
    try {
      const previous = await this.read();
      const retired: string[] = [];
      if (
        previous &&
        fleetRecordAuthority(previous) !== fleetRecordAuthority(safe)
      ) {
        for (const key of [
          safe.prepared.distribution === "microsoft-store"
            ? "store_active_runtime"
            : "active_runtime",
          "capacity",
        ]) {
          const stale = await this.native.vaultRead("fleet", key);
          if (stale) {
            stale.fill(0);
            if (!this.native.vaultDelete)
              throw new Error("FLEET_STATE_CORRUPT");
            retired.push(key);
          }
        }
      }
      await this.native.vaultWrite("fleet", "enrollment", bytes);
      const purged = await this.native.vaultRead("fleet", "purged_tombstone");
      if (purged) {
        purged.fill(0);
        if (!this.native.vaultDelete) throw new Error("FLEET_STATE_CORRUPT");
        await this.native.vaultDelete("fleet", "purged_tombstone");
      }
      // A failed replacement write leaves the old proof intact. After a committed replacement,
      // any unremoved old proof fails its immutable authority check for the new record.
      for (const key of retired) await this.native.vaultDelete!("fleet", key);
    } finally {
      await this.native.releaseMutex(lease);
    }
  }
  /** Only explicit same-owner renewal of the expired, never-activated phase.
   * Full-record CAS prevents a lost exchange ACK from erasing progressed state. */
  async renewInvitationIfCurrent(
    expected: FleetEnrollmentRecord,
    replacement: FleetEnrollmentRecord,
  ): Promise<FleetEnrollmentRecord> {
    const safe = parseFleetRecord(replacement, this.sid, this.origin);
    const lease = await this.native.acquireMutex("cache");
    if (!lease) throw new Error("FLEET_BUSY");
    try {
      const current = await this.read();
      if (
        !current ||
        !isDeepStrictEqual(current, expected) ||
        current.phase !== "invitation" ||
        Date.parse(current.invitationExpiresAt) > this.now() ||
        safe.phase !== "invitation" ||
        Date.parse(safe.invitationExpiresAt) <= this.now() ||
        safe.enrollmentCredential === current.enrollmentCredential ||
        !isDeepStrictEqual(
          [
            safe.sid,
            safe.ownerUid,
            safe.backendOrigin,
            safe.workerId,
            safe.machineCredential,
            safe.onboardingRevision,
            safe.requests,
          ],
          [
            current.sid,
            current.ownerUid,
            current.backendOrigin,
            current.workerId,
            current.machineCredential,
            current.onboardingRevision,
            current.requests,
          ],
        )
      )
        throw new Error("FLEET_SESSION_CHANGED");
      const bytes = Buffer.from(JSON.stringify(safe));
      if (bytes.length > 16384) throw new Error("FLEET_STATE_CORRUPT");
      try {
        await this.native.vaultWrite("fleet", "enrollment", bytes);
      } finally {
        bytes.fill(0);
      }
      return safe;
    } finally {
      await this.native.releaseMutex(lease);
    }
  }
  async writeIfCurrent(
    expectedAuthority: string,
    record: FleetEnrollmentRecord,
  ): Promise<void> {
    const lease = await this.native.acquireMutex("cache");
    if (!lease) throw new Error("FLEET_BUSY");
    try {
      const current = await this.read();
      if (!current || fleetRecordAuthority(current) !== expectedAuthority)
        throw new Error("ADVANCED_MACHINE_CHANGED");
      const safe = parseFleetRecord(record, this.sid, this.origin),
        bytes = Buffer.from(JSON.stringify(safe));
      if (
        fleetRecordAuthority(safe) !== expectedAuthority ||
        bytes.length > 16384
      )
        throw new Error("ADVANCED_MACHINE_CHANGED");
      await this.native.vaultWrite("fleet", "enrollment", bytes);
    } finally {
      await this.native.releaseMutex(lease);
    }
  }
  /** Called only after existing control-plane unpair confirmation is durably remembered. */
  async retireIfCurrent(
    expectedAuthority: string,
  ): Promise<FleetEnrollmentRecord> {
    const lease = await this.native.acquireMutex("cache");
    if (!lease) throw new Error("FLEET_BUSY");
    try {
      const current = await this.read();
      if (
        !current ||
        fleetRecordAuthority(current) !== expectedAuthority ||
        !current.machineId
      )
        throw new Error("ADVANCED_MACHINE_CHANGED");
      if (current.retiredAuthority === expectedAuthority) {
        if (!this.native.vaultDelete) throw new Error("FLEET_STATE_CORRUPT");
        for (const key of [
          "capacity",
          current.prepared.distribution === "microsoft-store"
            ? "store_active_runtime"
            : "active_runtime",
          "fleet_ticket",
          "child_bootstrap",
        ])
          await this.native.vaultDelete("fleet", key);
        return current;
      }
      const bytes = await this.native.vaultRead("fleet", "confirmed_unpair");
      if (!bytes || bytes.length > 2048)
        throw new Error("ADVANCED_REVOCATION_UNCONFIRMED");
      let receipt: Record<string, unknown>;
      try {
        receipt = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        ) as Record<string, unknown>;
        if (
          !receipt ||
          Object.keys(receipt).sort().join() !==
            "authority,confirmedAt,machineId,revision,version" ||
          receipt.version !== 1 ||
          receipt.machineId !== current.machineId ||
          receipt.authority !== expectedAuthority ||
          typeof receipt.confirmedAt !== "string" ||
          !Number.isFinite(Date.parse(receipt.confirmedAt)) ||
          !Number.isSafeInteger(receipt.revision) ||
          Number(receipt.revision) < 1
        )
          throw new Error("ADVANCED_REVOCATION_UNCONFIRMED");
      } finally {
        bytes.fill(0);
      }
      if (!this.native.vaultDelete) throw new Error("FLEET_STATE_CORRUPT");
      const retired = parseFleetRecord(
        {
          ...current,
          phase: "revoked",
          retiredAuthority: expectedAuthority,
          enrollmentCredential: null,
          installationCredential: null,
          machineCredential: null,
        },
        this.sid,
        this.origin,
      );
      await this.native.vaultWrite(
        "fleet",
        "enrollment",
        Buffer.from(JSON.stringify(retired)),
      );
      for (const key of [
        "capacity",
        current.prepared.distribution === "microsoft-store"
          ? "store_active_runtime"
          : "active_runtime",
        "fleet_ticket",
        "child_bootstrap",
      ])
        await this.native.vaultDelete("fleet", key);
      return retired;
    } finally {
      await this.native.releaseMutex(lease);
    }
  }
  async rememberUnpairAndRetire(
    expectedAuthority: string,
    confirmation: { machineId: string; revision: number; confirmedAt: string },
  ): Promise<FleetEnrollmentRecord> {
    const lease = await this.native.acquireMutex("cache");
    if (!lease) throw new Error("FLEET_BUSY");
    try {
      const current = await this.read();
      if (
        !current ||
        fleetRecordAuthority(current) !== expectedAuthority ||
        current.machineId !== confirmation.machineId
      )
        throw new Error("ADVANCED_MACHINE_CHANGED");
      if (
        !Number.isSafeInteger(confirmation.revision) ||
        confirmation.revision < 1 ||
        !Number.isFinite(Date.parse(confirmation.confirmedAt))
      )
        throw new Error("ADVANCED_REVOCATION_UNCONFIRMED");
      await this.native.vaultWrite(
        "fleet",
        "confirmed_unpair",
        Buffer.from(
          JSON.stringify({
            version: 1,
            machineId: confirmation.machineId,
            authority: expectedAuthority,
            revision: confirmation.revision,
            confirmedAt: confirmation.confirmedAt,
          }),
        ),
      );
    } finally {
      await this.native.releaseMutex(lease);
    }
    return this.retireIfCurrent(expectedAuthority);
  }
  async readPurgedTombstone(): Promise<FleetPurgedTombstone | null> {
    const bytes = await this.native.vaultRead("fleet", "purged_tombstone");
    if (!bytes) return null;
    try {
      if (bytes.length > 2048) throw new Error("FLEET_STATE_CORRUPT");
      return parseFleetPurgedTombstone(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        this.sid,
      );
    } finally {
      bytes.fill(0);
    }
  }
}
