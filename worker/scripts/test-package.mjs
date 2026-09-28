import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspectPackage } from "./package-policy.mjs";

// Exercise the exact packed bytes, with no workspace dependency resolution or
// access to the developer's installed worker. An optional output must be new.
const root = resolve(import.meta.dirname, "..");
if (process.argv.length > 3)
  throw new Error(
    "Usage: node scripts/test-package.mjs [new-output-directory]",
  );
const output = process.argv[2] ? resolve(process.argv[2]) : null;
if (output) await mkdir(output, { recursive: false, mode: 0o700 });
const temporary = await mkdtemp(join(tmpdir(), "musicmute-package-"));
try {
  const destination = output ?? temporary;
  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    ),
  )[0];
  const manifest = await inspectPackage(root, packed);
  const archive = join(destination, packed.filename);
  const consumer = join(temporary, "consumer");
  const home = join(temporary, "home");
  await mkdir(consumer);
  await mkdir(home, { mode: 0o700 });
  await writeFile(join(consumer, "package.json"), '{"private":true}\n');
  execFileSync(
    "npm",
    [
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org/",
      archive,
    ],
    {
      cwd: consumer,
      stdio: "pipe",
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    },
  );
  const cli = join(consumer, "node_modules/.bin/mw");
  const audit = JSON.parse(
    execFileSync(
      "npm",
      [
        "audit",
        "--omit=dev",
        "--json",
        "--registry=https://registry.npmjs.org/",
      ],
      {
        cwd: consumer,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    ),
  );
  assert.equal(
    audit.metadata?.vulnerabilities?.total,
    0,
    "Consumer dependency audit must be clean",
  );
  const run = (args) =>
    execFileSync(cli, args, {
      cwd: consumer,
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        HOME: home,
        NODE_PATH: "",
        NODE_OPTIONS: "",
        MUSICMUTE_SENTRY_ENABLED: "false",
      },
    });
  assert.match(run(["--help"]), /mw install/u);
  const version = JSON.parse(run(["--version", "--json"]));
  assert.equal(version.cliVersion, manifest.version);
  assert.equal(version.runtimeVersion, null);
  assert.equal(
    version.runtimeState,
    process.platform === "darwin" ? "not-installed" : "unsupported",
  );
  const sha256 = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  const evidence = {
    schemaVersion: 1,
    version: manifest.version,
    filename: packed.filename,
    sha256,
    integrity: packed.integrity,
    files: packed.files.length,
    packageSmoke: "passed",
    productionAcceptance: "not-run",
  };
  if (output)
    await writeFile(
      join(output, "package-evidence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
