import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile, spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, join, posix, resolve } from "node:path";
import { promisify } from "node:util";
import {
  assertRuntimeArchiveListing,
  collectRuntimeInventory,
  reuseMacRuntimeArtifact,
  runtimeDownloadConfiguration,
  verifyRuntimeCodeSignature,
} from "./macos-runtime-artifact.mjs";

const run = promisify(execFile);
const MAX_BYTES = 2_000_000_000;
const SHA256 = /^[a-f0-9]{64}$/;
const GROUPS = [
  "python-ml",
  "node",
  "audio-tools",
  "downloader",
  "javascript",
  "token-provider",
  "engine",
];

export function runtimeComponentForPath(path) {
  if (path.startsWith("runtime/runtime/python/")) return "python-ml";
  if (path.startsWith("runtime/runtime/node/")) return "node";
  if (
    path.startsWith("runtime/runtime/bin/") ||
    path.startsWith("runtime/runtime/licenses/") ||
    path === "runtime/runtime/media-source-manifest.json"
  )
    return "audio-tools";
  if (path.startsWith("runtime/tools/downloader/")) return "downloader";
  if (path.startsWith("runtime/tools/youtube/provider/"))
    return "token-provider";
  if (path.startsWith("runtime/tools/youtube/")) return "javascript";
  if (path.startsWith("runtime/app/engine/")) return "engine";
  throw new Error("RUNTIME_COMPONENT_PATH_UNAPPROVED");
}

export function validateRuntimeComponents(runtime) {
  const components = runtime.components;
  assert.ok(
    runtime.archive_format === "zip-components" &&
      Array.isArray(components) &&
      components.length >= 2 &&
      components.length <= 16,
    "RUNTIME_COMPONENTS_INVALID",
  );
  const paths = new Set(runtime.files.map((file) => file.path));
  const assigned = new Set();
  const ids = new Set();
  const urls = new Set();
  let bytes = 0;
  for (const component of components) {
    const url = new URL(component.url);
    assert.ok(
      GROUPS.includes(component.id) &&
        !ids.has(component.id) &&
        !urls.has(component.url) &&
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (!url.port || url.port === "443") &&
        runtime.download_hosts.includes(url.hostname) &&
        SHA256.test(component.archive_sha256) &&
        Number.isSafeInteger(component.archive_bytes) &&
        component.archive_bytes > 0 &&
        component.archive_bytes <= MAX_BYTES &&
        Array.isArray(component.file_paths) &&
        component.file_paths.length > 0,
      "RUNTIME_COMPONENTS_INVALID",
    );
    ids.add(component.id);
    urls.add(component.url);
    bytes += component.archive_bytes;
    for (const path of component.file_paths) {
      assert.ok(
        paths.has(path) &&
          !assigned.has(path) &&
          runtimeComponentForPath(path) === component.id,
        "RUNTIME_COMPONENTS_INVALID",
      );
      assigned.add(path);
    }
  }
  const checksum = createHash("sha256")
    .update(
      components.map((component) => component.archive_sha256).join("\n") + "\n",
    )
    .digest("hex");
  assert.ok(
    assigned.size === paths.size &&
      bytes === runtime.archive_bytes &&
      checksum === runtime.archive_sha256,
    "RUNTIME_COMPONENTS_INVALID",
  );
  for (const file of runtime.files.filter((file) => file.type === "symlink")) {
    const target = posix.normalize(
      posix.join(posix.dirname(file.path), file.link_target),
    );
    assert.equal(
      runtimeComponentForPath(target + "/"),
      runtimeComponentForPath(file.path),
      "RUNTIME_COMPONENT_LINK_CROSSES_STAGE",
    );
  }
}

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function safeFile(path, maximum = MAX_BYTES) {
  const info = await lstat(path);
  assert.ok(
    info.isFile() &&
      !info.isSymbolicLink() &&
      info.nlink === 1 &&
      info.uid === process.getuid() &&
      !(info.mode & 0o022) &&
      info.size > 0 &&
      info.size <= maximum,
    "RUNTIME_COMPONENT_FILE_UNSAFE",
  );
  return info;
}

async function zipFiles(root, output, paths) {
  await new Promise((accept, reject) => {
    const child = spawn(
      "/usr/bin/zip",
      ["-q", "-D", "-y", "-X", output, "-@"],
      { cwd: root, stdio: ["pipe", "ignore", "ignore"] },
    );
    const timeout = setTimeout(() => child.kill("SIGTERM"), 20 * 60_000);
    child.on("error", () => {
      clearTimeout(timeout);
      reject(new Error("RUNTIME_COMPONENT_ZIP_FAILED"));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) accept();
      else reject(new Error("RUNTIME_COMPONENT_ZIP_FAILED"));
    });
    child.stdin.on("error", () =>
      reject(new Error("RUNTIME_COMPONENT_ZIP_FAILED")),
    );
    child.stdin.end(paths.join("\n") + "\n");
  });
  await chmod(output, 0o600);
}

export async function createRuntimeComponents({
  packageResultPath,
  outputDirectory,
  downloadBaseURL,
  redirectHosts = "release-assets.githubusercontent.com",
}) {
  const prior = JSON.parse(await readFile(packageResultPath, "utf8"));
  assert.equal(
    prior.signing,
    "AD_HOC_LOCAL",
    "COMPONENT_DISTRIBUTION_REQUIRES_SEPARATE_RELEASE_QUALIFICATION",
  );
  const configuration = runtimeDownloadConfiguration({
    baseURL: downloadBaseURL,
    redirectHosts,
  });
  const output = resolve(outputDirectory);
  await mkdir(output, { mode: 0o700 });
  const scratch = join(output, `build-${randomUUID()}.noindex`);
  await mkdir(scratch, { mode: 0o700 });
  try {
    const checked = await reuseMacRuntimeArtifact({
      packageResultPath,
      outputDirectory: join(scratch, "runtime-release.noindex"),
      sourceVersion: prior.runtime.source_version,
      signing: { release: false, identity: "-", signing: "AD_HOC_LOCAL" },
    });
    const document = JSON.parse(await readFile(checked.manifest, "utf8"));
    const root = join(scratch, "extracted");
    const roundtrip = join(scratch, "roundtrip");
    await mkdir(root, { mode: 0o700 });
    await mkdir(roundtrip, { mode: 0o700 });
    await run(
      "/usr/bin/ditto",
      ["-x", "-k", "--noextattr", "--noqtn", "--noacl", checked.archive, root],
      { timeout: 20 * 60_000 },
    );
    const components = [];
    for (const id of GROUPS) {
      const files = document.runtime.files.filter(
        (file) => runtimeComponentForPath(file.path) === id,
      );
      if (!files.length) continue;
      const temporary = join(output, `.${id}-${randomUUID()}.zip`);
      await zipFiles(
        root,
        temporary,
        files.map((file) => file.path),
      );
      const sha256 = await digest(temporary);
      const filename = `MusicMuteLocal-${id}-macos-arm64-${sha256.slice(0, 16)}.zip`;
      const archive = join(output, filename);
      await copyFile(temporary, archive);
      await rm(temporary);
      await chmod(archive, 0o600);
      const { stdout } = await run("/usr/bin/unzip", ["-Z1", archive], {
        maxBuffer: 16 * 1024 * 1024,
      });
      assertRuntimeArchiveListing(stdout, files);
      await run(
        "/usr/bin/ditto",
        ["-x", "-k", "--noextattr", "--noqtn", "--noacl", archive, roundtrip],
        { timeout: 20 * 60_000 },
      );
      components.push({
        id,
        url: new URL(filename, configuration.baseURL).href,
        archive_sha256: sha256,
        archive_bytes: (await lstat(archive)).size,
        file_paths: files.map((file) => file.path),
      });
    }
    const extracted = await collectRuntimeInventory(roundtrip);
    assert.deepEqual(
      extracted.files,
      document.runtime.files,
      "RUNTIME_COMPONENT_ROUNDTRIP_INVALID",
    );
    assert.equal(extracted.installedBytes, document.runtime.installed_bytes);
    document.runtime.components = components;
    document.runtime.url = new URL(
      "runtime-bootstrap.json",
      configuration.baseURL,
    ).href;
    document.runtime.archive_format = "zip-components";
    document.runtime.download_hosts = configuration.downloadHosts;
    document.runtime.archive_bytes = components.reduce(
      (sum, item) => sum + item.archive_bytes,
      0,
    );
    document.runtime.archive_sha256 = createHash("sha256")
      .update(
        components.map((component) => component.archive_sha256).join("\n") +
          "\n",
      )
      .digest("hex");
    validateRuntimeComponents(document.runtime);
    const manifest = join(output, "runtime-bootstrap.json");
    const bytes = JSON.stringify(document, null, 2) + "\n";
    assert.ok(
      Buffer.byteLength(bytes) <= 16 * 1024 * 1024,
      "RUNTIME_MANIFEST_TOO_LARGE",
    );
    await writeFile(manifest, bytes, { mode: 0o600, flag: "wx" });
    return {
      directory: output,
      manifest,
      components,
      archive_bytes: document.runtime.archive_bytes,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function importRuntimeComponents({
  directory,
  outputDirectory,
  sourceVersion,
  signing,
}) {
  const source = await realpath(directory);
  assert.equal(source, resolve(directory), "RUNTIME_COMPONENT_SOURCE_UNSAFE");
  const info = await lstat(source);
  assert.ok(
    info.isDirectory() &&
      !info.isSymbolicLink() &&
      info.uid === process.getuid() &&
      !(info.mode & 0o022),
    "RUNTIME_COMPONENT_SOURCE_UNSAFE",
  );
  const sourceManifest = join(source, "runtime-bootstrap.json");
  await safeFile(sourceManifest, 16 * 1024 * 1024);
  const document = JSON.parse(await readFile(sourceManifest, "utf8"));
  const runtime = document.runtime;
  assert.ok(
    document.schema_version === 1 &&
      runtime.source_version === sourceVersion &&
      runtime.api_version === 1 &&
      runtime.platform === "darwin" &&
      runtime.arch === "arm64" &&
      runtime.signing.mode === "ad_hoc" &&
      signing.signing === "AD_HOC_LOCAL",
    "RUNTIME_COMPONENT_PACKAGE_MISMATCH",
  );
  validateRuntimeComponents(runtime);
  await mkdir(outputDirectory, { mode: 0o700 });
  const extraction = join(
    outputDirectory,
    `.verification-${randomUUID()}.noindex`,
  );
  await mkdir(extraction, { mode: 0o700 });
  const components = [];
  try {
    for (const component of runtime.components) {
      const filename = basename(new URL(component.url).pathname);
      assert.equal(
        filename,
        `MusicMuteLocal-${component.id}-macos-arm64-${component.archive_sha256.slice(0, 16)}.zip`,
        "RUNTIME_COMPONENT_FILENAME_INVALID",
      );
      const from = join(source, filename);
      const stat = await safeFile(from);
      assert.equal(stat.size, component.archive_bytes);
      assert.equal(await digest(from), component.archive_sha256);
      const archive = join(outputDirectory, filename);
      await copyFile(from, archive);
      await chmod(archive, 0o600);
      assert.equal(await digest(archive), component.archive_sha256);
      const selected = new Set(component.file_paths);
      const { stdout } = await run("/usr/bin/unzip", ["-Z1", archive], {
        maxBuffer: 16 * 1024 * 1024,
      });
      assertRuntimeArchiveListing(
        stdout,
        runtime.files.filter((file) => selected.has(file.path)),
      );
      await run(
        "/usr/bin/ditto",
        ["-x", "-k", "--noextattr", "--noqtn", "--noacl", archive, extraction],
        { timeout: 20 * 60_000 },
      );
      const { file_paths: _paths, ...metadata } = component;
      components.push({ ...metadata, archive });
    }
    const extracted = await collectRuntimeInventory(extraction);
    assert.deepEqual(
      extracted.files,
      runtime.files,
      "RUNTIME_COMPONENT_INVENTORY_INVALID",
    );
    assert.equal(extracted.installedBytes, runtime.installed_bytes);
    for (const file of extracted.files) {
      if (file.code_signed === true)
        await verifyRuntimeCodeSignature(
          join(extraction, file.path),
          runtime.signing,
        );
    }
  } finally {
    await rm(extraction, { recursive: true, force: true });
  }
  const manifest = join(outputDirectory, "runtime-bootstrap.json");
  await copyFile(sourceManifest, manifest);
  await chmod(manifest, 0o600);
  return {
    id: runtime.id,
    api_version: runtime.api_version,
    source_version: sourceVersion,
    archive_bytes: runtime.archive_bytes,
    archive_sha256: runtime.archive_sha256,
    installed_bytes: runtime.installed_bytes,
    manifest,
    manifest_sha256: await digest(manifest),
    url: runtime.url,
    files: runtime.files.length,
    native_binaries: runtime.files.filter((file) => file.code_signed === true)
      .length,
    reused: false,
    signing: runtime.signing,
    components,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  assert.equal(
    process.argv.length,
    5,
    "EXPECTED_PACKAGE_RESULT_OUTPUT_AND_RELEASE_BASE_URL",
  );
  const result = await createRuntimeComponents({
    packageResultPath: resolve(process.argv[2]),
    outputDirectory: resolve(process.argv[3]),
    downloadBaseURL: process.argv[4],
  });
  console.log(
    JSON.stringify(
      {
        directory: result.directory,
        bytes: result.archive_bytes,
        components: result.components.map(({ id, url, archive_bytes }) => ({
          id,
          url,
          bytes: archive_bytes,
        })),
      },
      null,
      2,
    ),
  );
}
