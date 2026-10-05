import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// Explicit development installation: consumes an existing qualified runtime
// read-only. This is not a standalone consumer installer or fleet enrollment.
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("UNSUPPORTED_PLATFORM");
const packageRoot = resolve(import.meta.dirname, "..");
const root =
  process.env.MUSICMUTE_LOCAL_ROOT ??
  join(homedir(), "Library/Application Support/MusicMuteLocalMvp");
if (!isAbsolute(root)) throw new Error("INVALID_LOCAL_ROOT");
const runtime = await realpath(
  process.env.MUSICMUTE_LOCAL_RUNTIME ??
    join(
      homedir(),
      "Library/Application Support/MusicMuteWorker/runtime/current",
    ),
);
const node = join(runtime, "runtime/node/bin/node");
const python = join(runtime, "runtime/python/bin/python3");
const host = join(packageRoot, "dist/companion/host.js");
const guard = join(packageRoot, "scripts/native-lock.py");
for (const file of [node, python]) await access(file, constants.X_OK);
for (const file of [host, guard, join(packageRoot, "engine/local_pipeline.py")])
  await access(file, constants.R_OK);
const extension = JSON.parse(
  await readFile(join(packageRoot, "dist/extension/manifest.json"), "utf8"),
);
if (typeof extension.key !== "string" || !extension.key)
  throw new Error("EXTENSION_MANIFEST_KEY_REQUIRED");
const key = Buffer.from(extension.key, "base64");
if (key.length < 128) throw new Error("EXTENSION_MANIFEST_KEY_INVALID");
const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
const extensionId = [...hash]
  .map((character) =>
    String.fromCharCode("a".charCodeAt(0) + Number.parseInt(character, 16)),
  )
  .join("");
const origin = `chrome-extension://${extensionId}/`;
const launcherPath = join(root, "native-launcher.sh");
const manifestRoot = join(
  homedir(),
  "Library/Application Support/Google/Chrome/NativeMessagingHosts",
);
const manifestPath = join(manifestRoot, "com.musicmute.local.json");
for (const directory of [root, join(root, "cache"), join(root, "logs")]) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await stat(directory)).mode & 0o077)
    throw new Error("LOCAL_DIRECTORY_NOT_PRIVATE");
}
await mkdir(manifestRoot, { recursive: true, mode: 0o700 });
let prior;
try {
  prior = JSON.parse(await readFile(manifestPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT")
    throw new Error("NATIVE_REGISTRATION_REQUIRES_REVIEW");
}
if (
  prior &&
  (prior.name !== "com.musicmute.local" ||
    prior.path !== launcherPath ||
    prior.allowed_origins?.length !== 1 ||
    prior.allowed_origins[0] !== origin)
) {
  throw new Error("FOREIGN_NATIVE_REGISTRATION_EXISTS");
}
if (prior) {
  const previousLauncher = await readFile(launcherPath, "utf8").catch(() => "");
  if (!previousLauncher.includes("# MusicMute Local MVP development launcher"))
    throw new Error("FOREIGN_NATIVE_LAUNCHER_EXISTS");
} else {
  try {
    await access(launcherPath);
    throw new Error("FOREIGN_NATIVE_LAUNCHER_EXISTS");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
const settings = {
  MUSICMUTE_LOCAL_ROOT: root,
  MUSICMUTE_LOCAL_RUNTIME: runtime,
  MUSICMUTE_LOCAL_MODELS:
    process.env.MUSICMUTE_LOCAL_MODELS ??
    join(homedir(), "Library/Application Support/MusicMuteWorker/models"),
  MUSICMUTE_LOCAL_YT_DLP:
    process.env.MUSICMUTE_LOCAL_YT_DLP ?? join(root, "tools/yt-dlp"),
  MUSICMUTE_LOCAL_RUNNER: join(packageRoot, "engine/local_pipeline.py"),
};
for (const value of Object.values(settings))
  if (!isAbsolute(value)) throw new Error("INVALID_LOCAL_CONFIG");
const launcher = [
  "#!/bin/sh",
  "# MusicMute Local MVP development launcher",
  // Start from a filtered environment; do not inherit worker/Sentry credentials.
  `exec /usr/bin/env -i HOME=${quote(homedir())} PATH='/usr/bin:/bin' LANG='en_US.UTF-8' ${Object.entries(
    settings,
  )
    .map(([name, value]) => `${name}=${quote(value)}`)
    .join(
      " ",
    )} ${quote(python)} -B ${quote(guard)} ${quote(node)} ${quote(host)} "$@"`,
  "",
].join("\n");
await writeFile(launcherPath, launcher, {
  mode: 0o700,
  flag: prior ? "w" : "wx",
});
await chmod(launcherPath, 0o700);
await writeFile(
  manifestPath,
  JSON.stringify(
    {
      name: "com.musicmute.local",
      description: "MusicMute Local MVP (macOS ARM64 development)",
      path: launcherPath,
      type: "stdio",
      allowed_origins: [origin],
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600, flag: prior ? "w" : "wx" },
);
await chmod(manifestPath, 0o600);
console.log(`Development native host registered for ${extensionId}.`);
console.log(
  `Load the unpacked extension from ${join(packageRoot, "dist/extension")}.`,
);
console.log(
  "Runtime and model were referenced read-only; no MusicMute worker service changes were made.",
);
