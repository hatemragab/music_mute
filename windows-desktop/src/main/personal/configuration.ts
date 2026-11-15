import { win32 } from "node:path";
import {
  isCurrentUserSid,
  type ConsumerProcessIdentity,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import {
  assertConsumerAbsolutePath,
  processIdentityFromWire,
  processIdentityToWire,
} from "../../../../worker/src/platform/windows/consumer-native-policy.js";
import {
  parseQualificationEvidence,
  type QualificationEvidence,
} from "../../../../worker/src/enrollment/report-builder.js";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import { PREPARATION_FIXTURE } from "../prepare/fixture.js";
import type { PrivateFileFingerprint } from "../prepare/private-files.js";
import { PersonalFailure } from "./controller.js";
import { accountApiOrigin } from "../../../../chrome-extension/src/companion/account-api.js";

export interface PersonalAgentConfiguration {
  version: 1;
  kind: "personal";
  installationProfile: "windows-user";
  release: string;
  releaseRoot: string;
  nativeSha256: string;
  personalRoot: string;
  sid: string;
  manifestSha256: string;
  qualification: unknown;
  bootIdentity: string;
  modelFingerprint: PrivateFileFingerprint;
  controlPeer: ConsumerProcessIdentity;
  admissionPeer: ConsumerProcessIdentity;
  eventsPeer: ConsumerProcessIdentity;
  backendOrigin?: string;
}
export function parsePersonalAgentConfiguration(value: unknown): {
  configuration: PersonalAgentConfiguration;
  evidence: QualificationEvidence;
} {
  const fail = (): never => {
    throw new PersonalFailure("PREPARE_REQUIRED");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join() !==
      [
        "version",
        "kind",
        "installationProfile",
        "release",
        "releaseRoot",
        "nativeSha256",
        "personalRoot",
        "sid",
        "manifestSha256",
        "qualification",
        "bootIdentity",
        "modelFingerprint",
        "controlPeer",
        "admissionPeer",
        "eventsPeer",
        ...(Object.hasOwn(row, "backendOrigin") ? ["backendOrigin"] : []),
      ]
        .sort()
        .join() ||
    row.version !== 1 ||
    row.kind !== "personal" ||
    row.installationProfile !== "windows-user" ||
    !isCurrentUserSid(row.sid) ||
    [row.release, row.nativeSha256, row.manifestSha256, row.bootIdentity].some(
      (text) => typeof text !== "string" || !/^[a-f0-9]{64}$/.test(text),
    ) ||
    typeof row.releaseRoot !== "string" ||
    typeof row.personalRoot !== "string"
  )
    fail();
  if (Object.hasOwn(row, "backendOrigin")) {
    try {
      if (
        typeof row.backendOrigin !== "string" ||
        accountApiOrigin(row.backendOrigin) !== row.backendOrigin
      )
        fail();
    } catch {
      fail();
    }
  }
  const controlPeer = processIdentityFromWire(
    processIdentityToWire(row.controlPeer as ConsumerProcessIdentity),
  );
  const admissionPeer = processIdentityFromWire(
    processIdentityToWire(row.admissionPeer as ConsumerProcessIdentity),
  );
  if (
    admissionPeer.sid !== row.sid ||
    admissionPeer.sessionId !== controlPeer.sessionId ||
    admissionPeer.pid === controlPeer.pid
  )
    fail();
  const eventsPeer = processIdentityFromWire(
    processIdentityToWire(row.eventsPeer as ConsumerProcessIdentity),
  );
  if (
    eventsPeer.sid !== row.sid ||
    eventsPeer.sessionId !== controlPeer.sessionId ||
    [admissionPeer.pid, controlPeer.pid].includes(eventsPeer.pid)
  )
    fail();
  if (controlPeer.sid !== row.sid) fail();
  assertConsumerAbsolutePath(row.releaseRoot as string);
  assertConsumerAbsolutePath(row.personalRoot as string);
  if (
    (row.releaseRoot as string).toLowerCase() !==
    win32
      .join(
        row.personalRoot as string,
        "runtime",
        "releases",
        row.release as string,
      )
      .toLowerCase()
  )
    fail();
  const fingerprint = row.modelFingerprint as PrivateFileFingerprint;
  if (
    !fingerprint ||
    typeof fingerprint !== "object" ||
    Object.keys(fingerprint).length !== 5 ||
    fingerprint.bytes !== MODEL.bytes ||
    [
      fingerprint.device,
      fingerprint.fileId,
      fingerprint.writtenAt,
      fingerprint.changedAt,
    ].some((item) => typeof item !== "string" || !/^\d{1,30}$/.test(item))
  )
    fail();
  let evidence: QualificationEvidence;
  try {
    evidence = parseQualificationEvidence(row.qualification, {
      runtimeProfile: "windows-user",
      expectedUserSid: row.sid as string,
      expectedFixtureDigest: PREPARATION_FIXTURE.sha256,
    });
  } catch {
    return fail();
  }
  if (
    evidence.modelDigest !== MODEL.sha256 ||
    evidence.releaseManifestDigest !== row.manifestSha256 ||
    evidence.runtimeDiagnostics?.onnxRuntime !== "1.24.4" ||
    !evidence.gpuIdentity
  )
    fail();
  return {
    configuration: row as unknown as PersonalAgentConfiguration,
    evidence,
  };
}
