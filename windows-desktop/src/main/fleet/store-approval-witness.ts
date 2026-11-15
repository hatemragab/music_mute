import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import {
  parseQualificationEvidence,
  resolveQualifiedGpuIdentity,
} from "../../../../worker/src/enrollment/report-builder.js";
import { WINDOWS_CONSUMER_PINS } from "../../../../worker/src/platform/windows/consumer-pins.js";
import type { HostContext } from "../host-context.js";
import { PERSONAL_RECIPE_DIGESTS } from "../personal/timeline.js";
import { readPrivateBytes } from "../prepare/private-files.js";
import { parseFleetRecord, type FleetEnrollmentRecord } from "./store.js";

/** Original approval observations only. Callers independently require their
 * genuine held Store code/role owner; these bytes confer no execution rights. */
export async function readApprovedLegacyFleetQualification(
  host: HostContext,
  enrollment: FleetEnrollmentRecord,
) {
  const record = parseFleetRecord(enrollment, host.identity.sid),
    relative = `prepare\\approved\\qualification-${createHash("sha256").update(record.requests.report).digest("hex")}.json`;
  if (
    record.phase !== "complete" ||
    !record.machineCredential ||
    record.prepared.distribution !== undefined ||
    record.prepared.modelDigest !== MODEL.sha256 ||
    record.prepared.qualificationPath !==
      win32.join(host.personalRoot, relative)
  )
    throw new Error("FLEET_INTEGRITY_INVALID");
  const bytes = await readPrivateBytes(host, relative, 16384);
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    if (text.charCodeAt(0) === 0xfeff)
      throw new Error("FLEET_INTEGRITY_INVALID");
    const evidence = parseQualificationEvidence(
      parseStrictJson(text, 16384, 1024),
      {
        runtimeProfile: "windows-user",
        expectedUserSid: record.sid,
        expectedFixtureDigest: record.prepared.fixtureDigest,
      },
    );
    if (
      !evidence.gpuIdentity ||
      evidence.releaseManifestDigest !== record.prepared.manifestDigest ||
      evidence.modelDigest !== MODEL.sha256 ||
      evidence.runtimeDiagnostics?.onnxRuntime !==
        WINDOWS_CONSUMER_PINS.onnxRuntime ||
      !isDeepStrictEqual(evidence.recipeDigests, PERSONAL_RECIPE_DIGESTS) ||
      evidence.uploadCandidate.path !== record.prepared.output.path ||
      evidence.uploadCandidate.resultDigest !== record.prepared.output.sha256 ||
      evidence.uploadCandidate.resultBytes !== record.prepared.output.bytes
    )
      throw new Error("FLEET_INTEGRITY_INVALID");
    resolveQualifiedGpuIdentity(record.prepared.gpu, [evidence.gpuIdentity]);
    if (!isDeepStrictEqual(record, enrollment))
      throw new Error("FLEET_INTEGRITY_INVALID");
    return Object.freeze({
      sha256: createHash("sha256").update(bytes).digest("hex"),
      evidence,
    });
  } finally {
    bytes.fill(0);
  }
}
