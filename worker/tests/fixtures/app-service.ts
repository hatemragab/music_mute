import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { APP_MODEL_SHA256 } from "../../src/platform/macos/app-installation-binding.js";
import {
  createMacUserDirectories,
  createMacUserLayout,
} from "../../src/platform/macos/user-paths.js";
import type { MacReleaseEntry } from "../../src/platform/macos/release-manifest.js";

export const borrowedAppModel = join(
  homedir(),
  "Library",
  "Application Support",
  "MusicMuteLocal",
  "models",
  APP_MODEL_SHA256,
  "Kim_Vocal_2.onnx",
);

/** Isolated fake tools/service; only approved model bytes are borrowed read-only. */
export async function appFixture(root: string) {
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  const layout = createMacUserLayout(home);
  await createMacUserDirectories(layout);
  const support = join(
    home,
    "Library",
    "Application Support",
    "MusicMuteLocal",
  );
  const resources = join(root, "resources");
  const source = join(resources, "worker", "service");
  for (const [path, text] of [
    ["app/dist/src/cli/main.js", "// fixture service"],
    ["app/LICENSE", "fixture license"],
    ["app/package.json", '{"version":"0.1.3"}'],
    ["app/engine/musicmute_engine/child.py", "# fixture child"],
    ["app/engine/musicmute_engine/qualification.py", "# fixture qualification"],
    ["app/engine/musicmute_engine/capacity_benchmark.py", "# fixture capacity"],
  ]) {
    await mkdir(dirname(join(source, path!)), { recursive: true, mode: 0o700 });
    await writeFile(join(source, path!), text!, { mode: 0o644 });
  }
  const entries: MacReleaseEntry[] = [];
  async function walk(directory: string) {
    const info = await lstat(directory);
    entries.push({
      path: relative(source, directory),
      kind: "directory",
      mode: info.mode & 0o777,
    });
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const child = await lstat(path);
      if (child.isDirectory()) await walk(path);
      else {
        const bytes = await import("node:fs/promises").then(({ readFile }) =>
          readFile(path),
        );
        entries.push({
          path: relative(source, path),
          kind: "file",
          bytes: child.size,
          mode: child.mode & 0o777,
          sha256: digest(bytes),
        });
      }
    }
  }
  await walk(join(source, "app"));
  entries.sort((a, b) => (a.path === b.path ? 0 : a.path < b.path ? -1 : 1));
  await writeFile(
    join(source, "service-manifest.json"),
    JSON.stringify({
      schema_version: 1,
      platform: "darwin",
      architecture: "arm64",
      worker_version: "0.1.3",
      api_version: 1,
      entries,
      payload_sha256: digest(Buffer.from(JSON.stringify(entries))),
    }),
    { mode: 0o644 },
  );
  const runtimeId = "macos-arm64-fixture-v1";
  const release = join(support, "runtime", "releases", runtimeId);
  const files: Record<string, unknown>[] = [];
  for (const path of [
    "runtime/runtime/node/bin/node",
    "runtime/runtime/python/bin/python3",
    "runtime/runtime/bin/ffmpeg",
    "runtime/runtime/bin/ffprobe",
  ]) {
    const bytes = Buffer.from(`fixture ${path}`);
    const absolute = join(release, path);
    await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
    await writeFile(absolute, bytes, { mode: 0o755 });
    files.push({
      path,
      type: "file",
      bytes: bytes.length,
      sha256: digest(bytes),
      executable: true,
      code_signed: false,
    });
  }
  const archiveHash = "a".repeat(64);
  await writeFile(
    join(resources, "runtime-bootstrap.json"),
    JSON.stringify({
      schema_version: 1,
      runtime: {
        id: runtimeId,
        api_version: 1,
        platform: "darwin",
        arch: "arm64",
        archive_sha256: archiveHash,
        signing: { mode: "ad_hoc", team_id: null },
        files,
      },
    }),
    { mode: 0o644 },
  );
  await writeFile(
    join(support, "runtime", "active.json"),
    JSON.stringify({
      schema_version: 1,
      runtime_id: runtimeId,
      api_version: 1,
      archive_sha256: archiveHash,
      release_path: `releases/${runtimeId}`,
    }),
    { mode: 0o600 },
  );
  await writeFile(join(support, "runtime", "bootstrap.lock"), "", {
    mode: 0o600,
  });
  const modelPath = join(
    support,
    "models",
    APP_MODEL_SHA256,
    "Kim_Vocal_2.onnx",
  );
  await mkdir(dirname(modelPath), { recursive: true, mode: 0o700 });
  await copyFile(borrowedAppModel, modelPath, constants.COPYFILE_FICLONE);
  await chmod(modelPath, 0o600);
  return {
    home,
    layout,
    support,
    resources,
    source,
    entries,
    release,
    files,
    runtimeId,
    modelPath,
  };
}
export function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
