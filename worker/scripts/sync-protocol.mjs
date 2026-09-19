import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(workerRoot, "..");
const sourcePath = resolve(
  repositoryRoot,
  "backend/src/worker-fleet/protocol/v1/protocol.ts",
);
const targetPath = resolve(workerRoot, "protocol/v1/protocol.ts");
const source = await readFile(sourcePath, "utf8");
const digest = createHash("sha256").update(source, "utf8").digest("hex");
const generated = `// GENERATED FILE - DO NOT EDIT.\n// Source: backend/src/worker-fleet/protocol/v1/protocol.ts\n// Source SHA-256: ${digest}\n\n${source}`;

if (process.argv.includes("--check")) {
  const current = await readFile(targetPath, "utf8").catch(() => "");
  if (current !== generated) {
    console.error("Worker protocol copy is stale; run pnpm protocol:sync");
    process.exitCode = 1;
  }
} else {
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, generated, "utf8");
  console.log(`Synchronized worker protocol ${digest}`);
}
