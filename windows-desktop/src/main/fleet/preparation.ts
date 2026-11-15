import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { win32 } from "node:path";
import {
  createEnrollmentReportFromDiagnostics,
  parseQualificationEvidence,
  resolveQualifiedGpuIdentity,
} from "../../../../worker/src/enrollment/report-builder.js";
import { downloadVerifiedArtifact } from "../../../../worker/src/enrollment/artifact-download.js";
import { verifyUpdateMetadata } from "../../../../worker/src/platform/shared/update-metadata.js";
import { BUILT_IN_UPDATE_TRUST } from "../../../../worker/src/platform/shared/update-trust.js";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import { PREPARATION_FIXTURE } from "../prepare/fixture.js";
import {
  hashPrivateFile,
  writePrivateAtomic,
} from "../prepare/private-files.js";
import type { WindowsPreparationOperations } from "../prepare/operations.js";
import type { HostContext } from "../host-context.js";
import type { FleetPreparationPort } from "./controller.js";
import { uploadPreparedFleetQualification } from "./controller.js";
import type { FleetEnrollmentRecord, FleetPreparedIdentity } from "./store.js";
import type { WorkerEnrollmentClient } from "../../../../worker/src/enrollment/enrollment-client.js";

/** Domain reuse: app readiness stays separate from backend-approved enrollment qualification. */
export class WindowsFleetPreparation implements FleetPreparationPort {
  constructor(
    private readonly host: HostContext,
    private readonly operations: Pick<
      WindowsPreparationOperations,
      "snapshotReady" | "qualifyApprovedFixture"
    >,
    private readonly options: {
      fetch?: typeof fetch;
      publicKeys?: Readonly<Record<string, string>>;
      label?: string;
    } = {},
  ) {}
  async snapshot(signal: AbortSignal): Promise<FleetPreparedIdentity> {
    const ready = await this.operations.snapshotReady(signal);
    const report = await createEnrollmentReportFromDiagnostics({
      releaseRoot: ready.releaseRoot,
      label: this.options.label ?? "MusicMute Windows",
      runtimeProfile: "windows-user",
      expectedUserSid: this.host.identity.sid,
      expectedFixtureDigest: PREPARATION_FIXTURE.sha256,
      diagnostics: { status: "ok", ...ready.evidence.runtimeDiagnostics },
      qualification: ready.qualification,
    });
    if (!ready.evidence.gpuIdentity) throw new Error("FLEET_PREPARE_REQUIRED");
    return {
      bootIdentity: ready.bootIdentity,
      release: ready.release,
      manifestDigest: ready.manifestSha256,
      archiveDigest: ready.archiveSha256,
      modelDigest: ready.modelSha256,
      fixtureDigest: PREPARATION_FIXTURE.sha256,
      gpu: ready.evidence.gpuIdentity,
      qualificationPath: null,
      output: {
        path: ready.evidence.uploadCandidate.path,
        bytes: ready.evidence.uploadCandidate.resultBytes,
        sha256: ready.evidence.uploadCandidate.resultDigest,
      },
      report,
    };
  }
  async verify(
    identity: FleetPreparedIdentity,
    signal: AbortSignal,
  ): Promise<void> {
    if (identity.distribution === "microsoft-store")
      throw new Error("FLEET_PREPARE_REQUIRED");
    const ready = await this.operations.snapshotReady(signal);
    if (
      ready.release !== identity.release ||
      ready.manifestSha256 !== identity.manifestDigest ||
      ready.archiveSha256 !== identity.archiveDigest ||
      ready.modelSha256 !== identity.modelDigest ||
      ready.bootIdentity !== identity.bootIdentity
    )
      throw new Error("FLEET_PREPARE_REQUIRED");
  }
  async qualify(
    record: FleetEnrollmentRecord,
    client: WorkerEnrollmentClient,
    signal: AbortSignal,
  ): Promise<FleetPreparedIdentity> {
    await this.verify(record.prepared, signal);
    const artifacts = await client.artifacts(
      record.installationId!,
      record.installationCredential!,
      "windows-amd64",
      signal,
      "windows-user",
    );
    const metadata = verifyUpdateMetadata(artifacts.release.signed, {
      platform: "windows-amd64",
      installationProfile: "windows-user",
      publicKeys: this.options.publicKeys ?? BUILT_IN_UPDATE_TRUST,
      minimumSequence: 1,
    });
    if (
      metadata.release.sha256 !== record.prepared.archiveDigest ||
      metadata.releaseVersion !== artifacts.release.version ||
      metadata.release.sha256 !== artifacts.release.sha256 ||
      metadata.release.bytes !== artifacts.release.bytes ||
      metadata.release.filename !== artifacts.release.filename ||
      metadata.release.contentType !== artifacts.release.contentType ||
      artifacts.model.sha256 !== MODEL.sha256 ||
      artifacts.model.bytes !== MODEL.bytes ||
      artifacts.model.filename !== MODEL.filename ||
      Date.parse(artifacts.fixture.expiresAt) <= Date.now() ||
      artifacts.fixture.bytes < 44 ||
      artifacts.fixture.bytes > 64 * 1024 ** 2
    )
      throw new Error("FLEET_PREPARE_REQUIRED");
    const relative = `prepare\\approved\\${artifacts.fixture.sha256}.wav`;
    await this.host.directory("prepare\\approved");
    const path = win32.join(this.host.personalRoot, relative);
    try {
      await lstat(path);
      await this.host.native.validatePath("personal", relative, "file");
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
      await this.host.native.validatePath("personal", relative, "absent");
    }
    await downloadVerifiedArtifact({
      url: artifacts.fixture.url,
      outputPath: path,
      expectedBytes: artifacts.fixture.bytes,
      expectedSha256: artifacts.fixture.sha256,
      expectedContentType: "audio/wav",
      signal,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
    if (
      (await hashPrivateFile(
        this.host,
        relative,
        artifacts.fixture.bytes,
        signal,
      )) !== artifacts.fixture.sha256
    )
      throw new Error("FLEET_QUALIFICATION_REJECTED");
    const result = await this.operations.qualifyApprovedFixture(
      {
        relativePath: relative,
        bytes: artifacts.fixture.bytes,
        sha256: artifacts.fixture.sha256,
      },
      signal,
    );
    const evidence = parseQualificationEvidence(result.raw, {
      runtimeProfile: "windows-user",
      expectedUserSid: this.host.identity.sid,
      expectedFixtureDigest: artifacts.fixture.sha256,
    });
    const ready = await this.operations.snapshotReady(signal);
    if (
      evidence.releaseManifestDigest !== record.prepared.manifestDigest ||
      evidence.modelDigest !== record.prepared.modelDigest ||
      result.bootIdentity !== ready.bootIdentity ||
      ready.bootIdentity !== (await this.host.native.bootIdentity()) ||
      !evidence.gpuIdentity
    )
      throw new Error("FLEET_QUALIFICATION_REJECTED");
    resolveQualifiedGpuIdentity(record.prepared.gpu, [evidence.gpuIdentity]);
    const report = await createEnrollmentReportFromDiagnostics({
      releaseRoot: ready.releaseRoot,
      label: record.label,
      runtimeProfile: "windows-user",
      expectedUserSid: this.host.identity.sid,
      expectedFixtureDigest: artifacts.fixture.sha256,
      diagnostics: { status: "ok", ...evidence.runtimeDiagnostics },
      qualification: result.raw,
    });
    const qualificationRelative = `prepare\\approved\\qualification-${createHash("sha256").update(record.requests.report).digest("hex")}.json`;
    await writePrivateAtomic(
      this.host,
      qualificationRelative,
      Buffer.from(JSON.stringify(result.raw)),
    );
    return {
      bootIdentity: result.bootIdentity,
      release: record.prepared.release,
      manifestDigest: evidence.releaseManifestDigest,
      archiveDigest: record.prepared.archiveDigest,
      modelDigest: evidence.modelDigest,
      fixtureDigest: evidence.fixtureDigest,
      gpu: evidence.gpuIdentity,
      qualificationPath: win32.join(
        this.host.personalRoot,
        qualificationRelative,
      ),
      output: {
        path: evidence.uploadCandidate.path,
        bytes: evidence.uploadCandidate.resultBytes,
        sha256: evidence.uploadCandidate.resultDigest,
      },
      report,
    };
  }
  async upload(
    record: FleetEnrollmentRecord,
    client: WorkerEnrollmentClient,
    signal: AbortSignal,
  ): Promise<void> {
    const relative = win32.relative(
      this.host.personalRoot,
      record.prepared.output.path,
    );
    await this.host.native.validatePath("personal", relative, "file");
    if (
      (await hashPrivateFile(
        this.host,
        relative,
        record.prepared.output.bytes,
        signal,
      )) !== record.prepared.output.sha256
    )
      throw new Error("FLEET_QUALIFICATION_REJECTED");
    await uploadPreparedFleetQualification(
      record,
      client,
      signal,
      this.options.fetch,
    );
  }
}
