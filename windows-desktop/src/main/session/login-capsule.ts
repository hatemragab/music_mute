import { createHash } from "node:crypto";
import type { WindowsReleaseManifest } from "../../../../worker/src/platform/windows/release-manifest.js";
import type { WindowsConsumerNative } from "../../../../worker/src/platform/windows/consumer-native.js";
import type { HostContext } from "../host-context.js";
import { captureWorkerResourceCapsule } from "../browser/package-trust.js";
import { writePrivateAtomic } from "../prepare/private-files.js";
import type { SessionBootstrapReceipt } from "./activation.js";

export interface WorkerLoginReceipt {
  version: 1;
  sid: string;
  release: string;
  nodeSha256: string;
  nativeSha256: string;
  entrySha256: string;
  launcherSha256: string;
  capsuleSha256: string;
}
/** Must run under the existing activation lease. Nothing here downloads or changes worker intent. */
export async function publishWorkerLoginCapsule(
  host: HostContext,
  native: WindowsConsumerNative,
  manifest: WindowsReleaseManifest,
  bootstrap: SessionBootstrapReceipt,
): Promise<WorkerLoginReceipt> {
  const entry = manifest.entries.find(
    (row) => row.kind === "file" && row.path === "agent/login-worker.cjs",
  );
  if (entry?.kind !== "file" || entry.bytes < 1 || entry.bytes > 32 * 1024 ** 2)
    throw new Error("SESSION_INTEGRITY_INVALID");
  const { capsule, files } = await captureWorkerResourceCapsule();
  const bytes = Buffer.from(JSON.stringify(capsule)),
    capsuleSha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length > 8192) throw new Error("SESSION_INTEGRITY_INVALID");
  const relative = `login\\${capsuleSha256}`;
  for (const file of files)
    await writePrivateAtomic(
      host,
      `${relative}\\resources\\${file.path.replaceAll("/", "\\")}`,
      file.bytes,
    );
  await writePrivateAtomic(host, `${relative}\\capsule.json`, bytes);
  await native.retainSessionLauncher(
    bootstrap.launcherSha256,
    capsule.publisherSha256,
  );
  const receipt: WorkerLoginReceipt = {
    version: 1,
    sid: host.identity.sid,
    release: bootstrap.release,
    nodeSha256: bootstrap.nodeSha256,
    nativeSha256: bootstrap.nativeSha256,
    entrySha256: entry.sha256,
    launcherSha256: bootstrap.launcherSha256,
    capsuleSha256,
  };
  await native.vaultWrite(
    "fleet",
    "login_bootstrap",
    Buffer.from(JSON.stringify(receipt)),
  );
  return receipt;
}
