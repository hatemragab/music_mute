import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { verifyWindowsRelease } from "../../../../../worker/src/platform/windows/release-manifest.js";
import type { HostContext } from "../../host-context.js";
import { parseRuntimeProof } from "../../prepare/operations.js";
import { readPrivateBytes } from "../../prepare/private-files.js";
export interface AdvancedCandidateIdentity {
  release: string;
  manifestSha256: string;
  engineDigest: string;
}
/** Only a previously signed/verified fixed consumer inventory may provide candidate code. */
export async function verifyAdvancedCandidate(
  host: HostContext,
  release: string,
  signal: AbortSignal,
): Promise<AdvancedCandidateIdentity> {
  if (!/^[a-f0-9]{64}$/u.test(release))
    throw new Error("ADVANCED_CANDIDATE_INVALID");
  signal.throwIfAborted();
  const raw = await host.native.vaultRead(
    "account",
    `runtime_${release.slice(0, 56)}`,
  );
  if (!raw || raw.length > 4096)
    throw new Error("ADVANCED_CANDIDATE_UNAVAILABLE");
  let proof;
  try {
    const row = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(raw),
    ) as { archiveSha256: string; sequence: number };
    if (
      !/^[a-f0-9]{64}$/u.test(row.archiveSha256) ||
      !Number.isSafeInteger(row.sequence) ||
      row.sequence < 1
    )
      throw new Error();
    proof = parseRuntimeProof(row, {
      sid: host.identity.sid,
      release,
      archiveSha256: row.archiveSha256,
      sequence: row.sequence,
    });
  } catch {
    throw new Error("ADVANCED_CANDIDATE_INVALID");
  } finally {
    raw.fill(0);
  }
  const relative = `runtime\\releases\\${release}`,
    root = win32.join(host.personalRoot, relative);
  await host.native.validatePath("personal", relative, "directory");
  const manifest = await verifyWindowsRelease(root, "windows-user"),
    bytes = await readPrivateBytes(
      host,
      `${relative}\\release-manifest.json`,
      16 * 1024 ** 2,
    );
  if (createHash("sha256").update(bytes).digest("hex") !== proof.manifestSha256)
    throw new Error("ADVANCED_CANDIDATE_INVALID");
  for (const entry of manifest.entries) {
    signal.throwIfAborted();
    await host.native.validatePath(
      "personal",
      `${relative}\\${entry.path.replaceAll("/", "\\")}`,
      entry.kind === "file" ? "file" : "directory",
    );
  }
  const sources = manifest.entries
    .filter(
      (entry) =>
        entry.kind === "file" &&
        entry.path.startsWith("app/engine/musicmute_engine/") &&
        entry.path.endsWith(".py"),
    )
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (sources.length < 1 || sources.length > 200)
    throw new Error("ADVANCED_CANDIDATE_INVALID");
  const digest = createHash("sha256");
  let total = 0;
  for (const entry of sources) {
    signal.throwIfAborted();
    if (entry.kind !== "file") throw new Error("ADVANCED_CANDIDATE_INVALID");
    const content = await readPrivateBytes(
      host,
      `${relative}\\${entry.path.replaceAll("/", "\\")}`,
      10 * 1024 ** 2,
    );
    total += content.length;
    if (
      total > 10 * 1024 ** 2 ||
      content.length !== entry.bytes ||
      createHash("sha256").update(content).digest("hex") !== entry.sha256
    )
      throw new Error("ADVANCED_CANDIDATE_INVALID");
    digest
      .update(entry.path.slice("app/engine/".length).replaceAll("/", "\\"))
      .update("\0")
      .update(content)
      .update("\0");
  }
  return {
    release,
    manifestSha256: proof.manifestSha256,
    engineDigest: digest.digest("hex"),
  };
}
