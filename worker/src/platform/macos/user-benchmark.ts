import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { parseQualificationEvidence } from "../../enrollment/report-builder.js";
import { loadLocalLifecycle } from "../../runtime/local-lifecycle.js";
import {
  MacLaunchAgentController,
  writeLaunchAgentPlist,
} from "./launch-agent.js";
import { qualifyMacUserRelease } from "./user-installer.js";
import type { MacUserLayout } from "./user-paths.js";

export async function benchmarkMacUserWorker(options: {
  layout: MacUserLayout;
  uid: number;
  launchAgent?: Pick<
    MacLaunchAgentController,
    "bootstrap" | "bootout" | "status"
  >;
  qualify?: typeof qualifyMacUserRelease;
}) {
  const lifecycle = await loadLocalLifecycle(options.layout.lifecyclePath);
  const launchAgent =
    options.launchAgent ?? new MacLaunchAgentController(options.uid);
  const service = await launchAgent.status();
  if (lifecycle.intent !== "draining" || service.loaded)
    throw new Error(
      "Benchmark requires an already-drained and stopped worker; run drain, wait for jobs, then stop",
    );
  const releaseRoot = await realpath(options.layout.currentLink);
  const trustedRoot = resolve(options.layout.releasesRoot);
  if (!releaseRoot.startsWith(`${trustedRoot}${sep}`))
    throw new TypeError("Active release is outside the trusted runtime root");
  const fixturePath = join(options.layout.stateRoot, "qualification.wav");
  const fixtureSha256 = await sha256(fixturePath);
  const qualify = options.qualify ?? qualifyMacUserRelease;
  try {
    const reportPath = await qualify(
      options.layout,
      releaseRoot,
      fixturePath,
      fixtureSha256,
      launchAgent,
    );
    return parseQualificationEvidence(
      JSON.parse(await readFile(reportPath, "utf8")) as unknown,
    );
  } finally {
    await writeLaunchAgentPlist(options.layout);
  }
}

async function sha256(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
