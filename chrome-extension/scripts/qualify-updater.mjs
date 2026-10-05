// Uses only a throwaway deterministic fixture key; never reads the login Keychain.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { prepareSparkle } from "./sparkle-artifacts.mjs";
import { updateAppcast } from "./prepare-macos-update.mjs";
const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
if (
  process.platform !== "darwin" ||
  process.arch !== "arm64" ||
  process.argv.length !== 2
)
  throw new Error("INVALID_UPDATER_QUALIFICATION_OPTIONS");
const tools = await prepareSparkle();
const output = join(root, "output/updater-fixtures.noindex", randomUUID());
await mkdir(output, { recursive: true, mode: 0o700 });
const key = join(output, "fixture-key.txt");
await writeFile(key, Buffer.alloc(32, 9).toString("base64"), { mode: 0o600 });
const archive = join(output, "fixture.dmg");
const content = Buffer.from(
  "Synthetic updater fixture; not a Mac installer.\n",
);
await writeFile(archive, content, { mode: 0o600 });
const settings = {
  timeout: 30_000,
  maxBuffer: 128 * 1024,
  env: { PATH: "/usr/bin:/bin", HOME: output, LANG: "en_US.UTF-8" },
};
const sign = join(tools, "bin/sign_update");
try {
  const signature = (
    await exec(sign, ["--ed-key-file", key, "-p", archive], settings)
  ).stdout.trim();
  await exec(
    sign,
    ["--ed-key-file", key, "--verify", archive, signature],
    settings,
  );
  const feed = join(output, "appcast.xml");
  await writeFile(
    feed,
    updateAppcast({
      version: "0.2.0",
      build: "2",
      archiveURL: "https://updates.example.com/fixture.dmg",
      signature,
      bytes: content.length,
    }),
    { mode: 0o600 },
  );
  await exec(sign, ["--ed-key-file", key, "-p", feed], settings);
  await exec(sign, ["--ed-key-file", key, "--verify", feed], settings);
  await writeFile(archive, Buffer.concat([content, Buffer.from("changed")]));
  let rejected = false;
  try {
    await exec(
      sign,
      ["--ed-key-file", key, "--verify", archive, signature],
      settings,
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("TAMPERED_UPDATE_ACCEPTED");
  console.log(
    JSON.stringify({
      framework: "Sparkle",
      version: "2.10.0",
      synthetic_archive_signature_verified: true,
      synthetic_feed_signature_verified: true,
      modified_archive_rejected: true,
      production_update_tested: false,
    }),
  );
} finally {
  await rm(output, { recursive: true, force: true });
}
