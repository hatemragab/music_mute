import { createHash } from "node:crypto";
import { lstat, unlink } from "node:fs/promises";
import { win32 } from "node:path";
import type { HostContext } from "../../host-context.js";
import type { FleetEnrollmentRecord } from "../store.js";
import {
  hashPrivateFile,
  readPrivateBytes,
} from "../../prepare/private-files.js";
import { parseQualificationEvidence } from "../../../../../worker/src/enrollment/report-builder.js";
/** Purge only the exact fleet-approved qualification artifacts; personal Ready/model/runtime are referenced separately. */
export async function purgeFleetQualificationArtifacts(
  host: HostContext,
  record: FleetEnrollmentRecord,
  signal: AbortSignal,
): Promise<number> {
  const reportRelative = `prepare\\approved\\qualification-${createHash("sha256").update(record.requests.report).digest("hex")}.json`;
  if (
    !record.prepared.qualificationPath ||
    win32.resolve(record.prepared.qualificationPath).toLowerCase() !==
      win32.resolve(win32.join(host.personalRoot, reportRelative)).toLowerCase()
  )
    throw new Error("ADVANCED_PURGE_SCOPE_INVALID");
  const outputRelative = win32.relative(
    host.personalRoot,
    record.prepared.output.path,
  );
  if (
    !/^prepare\\work\\[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\\[A-Za-z0-9._\\-]+$/iu.test(
      outputRelative,
    ) ||
    outputRelative.split("\\").some((part) => part === ".." || part === ".")
  )
    throw new Error("ADVANCED_PURGE_SCOPE_INVALID");
  let removed = 0;
  const remove = async (
    relative: string,
    expected?: { bytes: number; sha256: string },
  ) => {
    signal.throwIfAborted();
    const path = win32.join(host.personalRoot, relative);
    let stat;
    try {
      stat = await lstat(path, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await host.native.validatePath("personal", relative, "file");
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1n ||
      stat.size > 64n * 1024n ** 2n
    )
      throw new Error("ADVANCED_FILE_INVALID");
    if (
      expected &&
      (Number(stat.size) !== expected.bytes ||
        (await hashPrivateFile(host, relative, expected.bytes, signal)) !==
          expected.sha256)
    )
      throw new Error("ADVANCED_FILE_CHANGED");
    const current = await lstat(path, { bigint: true });
    if (
      current.ino !== stat.ino ||
      current.dev !== stat.dev ||
      current.mtimeNs !== stat.mtimeNs ||
      current.size !== stat.size ||
      current.isSymbolicLink() ||
      current.nlink !== 1n
    )
      throw new Error("ADVANCED_FILE_CHANGED");
    await unlink(path);
    removed += Number(stat.size);
  };
  try {
    const raw = await readPrivateBytes(host, reportRelative, 16 * 1024 ** 2),
      evidence = parseQualificationEvidence(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
        {
          runtimeProfile: "windows-user",
          expectedUserSid: host.identity.sid,
          expectedFixtureDigest: record.prepared.fixtureDigest,
        },
      );
    if (
      evidence.releaseManifestDigest !== record.prepared.manifestDigest ||
      evidence.modelDigest !== record.prepared.modelDigest ||
      win32.resolve(evidence.uploadCandidate.path).toLowerCase() !==
        win32.resolve(record.prepared.output.path).toLowerCase() ||
      evidence.uploadCandidate.resultDigest !== record.prepared.output.sha256 ||
      evidence.uploadCandidate.resultBytes !== record.prepared.output.bytes
    )
      throw new Error("ADVANCED_PURGE_SCOPE_INVALID");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await remove(outputRelative, {
    bytes: record.prepared.output.bytes,
    sha256: record.prepared.output.sha256,
  });
  const ready = await host.native.vaultRead("account", "ready_receipt");
  let sharedFixture = false;
  if (ready) {
    try {
      const value = JSON.parse(ready.toString("utf8")) as {
        fixtureSha256?: unknown;
      };
      sharedFixture = value.fixtureSha256 === record.prepared.fixtureDigest;
    } finally {
      ready.fill(0);
    }
  }
  if (!sharedFixture) {
    const relative = `prepare\\approved\\${record.prepared.fixtureDigest}.wav`;
    try {
      const stat = await lstat(win32.join(host.personalRoot, relative));
      await remove(relative, {
        bytes: stat.size,
        sha256: record.prepared.fixtureDigest,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await remove(reportRelative);
  return removed;
}
