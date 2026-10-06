import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const FORBIDDEN =
  /(?:^\.env(?:\.|$)|\.(?:credential|pem|key|p12|pfx|onnx|pt|pth|dmg|zip|log)$)/iu;
const REQUIRED = [
  "app/package.json",
  "app/dist/package.json",
  "app/dist/src/cli/main.js",
  "app/dist/src/cli/app-control.js",
  "app/dist/src/agent/process-guardian.js",
  "app/dist/src/runtime/worker-runtime.js",
  "app/dist/src/runtime/personal-admission.js",
  "app/dist/protocol/v1/protocol.js",
  "app/engine/musicmute_engine/__main__.py",
  "app/engine/musicmute_engine/service_doctor.py",
  "app/engine/musicmute_engine/qualification.py",
  "app/engine/musicmute_engine/pipeline.py",
  "app/engine/musicmute_engine/separator.py",
  "app/LICENSE",
];

/** Complete code/dependency payload; interpreter, tools, model and user state stay external. */
export async function stageWorkerService({
  workerRoot,
  outputRoot,
  installDependencies,
}) {
  workerRoot = resolve(workerRoot);
  outputRoot = resolve(outputRoot);
  await assertSafeDirectory(workerRoot);
  const sourcePackage = JSON.parse(
    await readFile(join(workerRoot, "package.json"), "utf8"),
  );
  if (
    sourcePackage.name !== "@music-mute/worker" ||
    !VERSION.test(sourcePackage.version ?? "")
  )
    throw new Error("WORKER_PACKAGE_INVALID");
  await mkdir(dirname(outputRoot), { recursive: true });
  await assertSafeDirectory(dirname(outputRoot));
  const previous = await lstat(outputRoot).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (previous) throw new Error("WORKER_SERVICE_OUTPUT_EXISTS");
  const staging = join(
    dirname(outputRoot),
    `.worker-service-${randomUUID()}.noindex`,
  );
  await mkdir(staging, { mode: 0o755 });
  try {
    const app = join(staging, "app");
    await mkdir(app, { mode: 0o755 });
    const manifest = {
      name: sourcePackage.name,
      version: sourcePackage.version,
      private: true,
      type: "module",
      license: sourcePackage.license,
      engines: sourcePackage.engines,
      packageManager: sourcePackage.packageManager,
      dependencies: sourcePackage.dependencies ?? {},
    };
    await writeFile(
      join(app, "package.json"),
      `${JSON.stringify(sourcePackage, null, 2)}\n`,
      { mode: 0o644 },
    );
    const dist = join(workerRoot, "dist");
    await assertSafeDirectory(dist);
    for (const folder of ["src", "protocol"]) {
      await cp(join(dist, folder), join(app, "dist", folder), {
        recursive: true,
        verbatimSymlinks: true,
        mode: constants.COPYFILE_FICLONE,
        filter: (path) => !path.endsWith(".map") && !path.endsWith(".d.ts"),
      });
    }
    // app-control's compiled JSON import is relative to dist/src/cli, whereas
    // version/reporting use app/package.json. Both have the same public identity.
    await mkdir(join(app, "dist"), { recursive: true });
    await cp(join(app, "package.json"), join(app, "dist", "package.json"));
    await cp(join(workerRoot, "LICENSE"), join(app, "LICENSE"));
    const engine = join(workerRoot, "engine", "musicmute_engine");
    await assertSafeDirectory(engine);
    const engineNames = (await readdir(engine)).filter((name) =>
      /^[A-Za-z_][A-Za-z0-9_]*\.py$/u.test(name),
    );
    await mkdir(join(app, "engine", "musicmute_engine"), { recursive: true });
    for (const name of engineNames) {
      const source = join(engine, name);
      const info = await lstat(source);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
        throw new Error("WORKER_ENGINE_SOURCE_UNSAFE");
      await cp(source, join(app, "engine", "musicmute_engine", name));
    }
    const installer =
      installDependencies ??
      (
        await import(
          pathToFileURL(
            join(dist, "src", "platform", "production-dependencies.js"),
          ).href
        )
      ).installProductionDependencies;
    await installer(workerRoot, app);
    await writeFile(
      join(app, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    // Installer metadata contains machine-specific store paths and is not
    // needed to execute the frozen production closure.
    for (const name of [
      "pnpm-lock.yaml",
      "node_modules/.modules.yaml",
      "node_modules/.pnpm-workspace-state-v1.json",
    ])
      await rm(join(app, name), { force: true });
    const modules = join(app, "node_modules");
    if (
      await lstat(modules).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      })
    ) {
      // Detach package-manager hard links before changing permissions. The
      // resulting closure must not depend on a developer's package store.
      const detached = join(app, "node_modules.detached");
      await cp(modules, detached, {
        recursive: true,
        verbatimSymlinks: true,
        mode: constants.COPYFILE_FICLONE,
        filter: (path) =>
          !path.endsWith(".map") && !/\.d\.(?:ts|cts|mts)$/u.test(path),
      });
      await rm(modules, { recursive: true });
      await rename(detached, modules);
    }
    for (const name of ["main", "app-control"])
      await chmod(join(app, "dist", "src", "cli", `${name}.js`), 0o755);
    await normalizePermissions(app);
    const entries = await inventoryWorkerService(staging);
    assertRequired(entries);
    const service = {
      schema_version: 1,
      platform: "darwin",
      architecture: "arm64",
      worker_version: sourcePackage.version,
      api_version: 1,
      entries,
      payload_sha256: entriesDigest(entries),
    };
    await writeFile(
      join(staging, "service-manifest.json"),
      `${JSON.stringify(service, null, 2)}\n`,
      { mode: 0o644 },
    );
    await verifyWorkerService(staging);
    await rename(staging, outputRoot);
    return service;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function entriesDigest(entries) {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/** Ship compressed code in the thin app; installer validates and materializes it externally. */
export async function createCompressedWorkerService({
  sourceRoot,
  outputRoot,
  signNative,
}) {
  let manifest = await verifyWorkerService(sourceRoot);
  outputRoot = resolve(outputRoot);
  await mkdir(dirname(outputRoot), { recursive: true });
  await assertSafeDirectory(dirname(outputRoot));
  if (
    await lstat(outputRoot).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    })
  )
    throw new Error("WORKER_SERVICE_OUTPUT_EXISTS");
  const staging = join(
    dirname(outputRoot),
    `.worker-service-${randomUUID()}.noindex`,
  );
  await mkdir(staging, { mode: 0o755 });
  let signedRoot;
  try {
    const native = await nativeServiceFiles(sourceRoot, manifest.entries);
    if (native.length) {
      if (!signNative) throw new Error("WORKER_NATIVE_SIGNER_REQUIRED");
      signedRoot = join(
        dirname(outputRoot),
        `.worker-service-signed-${randomUUID()}.noindex`,
      );
      await mkdir(signedRoot, { mode: 0o755 });
      await cp(join(sourceRoot, "app"), join(signedRoot, "app"), {
        recursive: true,
        verbatimSymlinks: true,
        mode: constants.COPYFILE_FICLONE,
      });
      for (const path of native) await signNative(join(signedRoot, path));
      const entries = await inventoryWorkerService(signedRoot);
      manifest = {
        ...manifest,
        entries,
        payload_sha256: entriesDigest(entries),
      };
      await writeFile(
        join(signedRoot, "service-manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { mode: 0o644 },
      );
      await verifyWorkerService(signedRoot);
    }
    const archiveSource = signedRoot ?? sourceRoot;
    const archivePath = join(staging, "service-payload.zip");
    await execute(
      "/usr/bin/zip",
      ["-q", "-r", "-X", "-y", archivePath, "app"],
      {
        cwd: resolve(archiveSource),
        timeout: 120000,
        maxBuffer: 65536,
        env: { PATH: "/usr/bin:/bin", LANG: "C", COPYFILE_DISABLE: "1" },
      },
    );
    await chmod(archivePath, 0o644);
    const info = await lstat(archivePath);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size < 1 ||
      info.size > 128 * 1024 ** 2
    )
      throw new Error("WORKER_SERVICE_ARCHIVE_INVALID");
    const archive = {
      schema_version: 1,
      filename: "service-payload.zip",
      bytes: info.size,
      sha256: createHash("sha256")
        .update(await readFile(archivePath))
        .digest("hex"),
    };
    await cp(
      join(archiveSource, "service-manifest.json"),
      join(staging, "service-manifest.json"),
    );
    await writeFile(
      join(staging, "archive.json"),
      `${JSON.stringify(archive, null, 2)}\n`,
      { mode: 0o644 },
    );
    await verifyCompressedWorkerService(staging);
    await rename(staging, outputRoot);
    return {
      ...archive,
      payload_sha256: manifest.payload_sha256,
      worker_version: manifest.worker_version,
      native_binaries: native.length,
      expanded_bytes: manifest.entries.reduce(
        (total, entry) => total + (entry.bytes ?? 0),
        0,
      ),
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (signedRoot) await rm(signedRoot, { recursive: true, force: true });
  }
}

async function nativeServiceFiles(root, entries) {
  const result = [];
  const magic = new Set([
    "feedface",
    "feedfacf",
    "cefaedfe",
    "cffaedfe",
    "cafebabe",
    "bebafeca",
    "cafebabf",
    "bfbafeca",
  ]);
  for (const entry of entries) {
    if (entry.kind !== "file") continue;
    const handle = await open(join(root, entry.path), "r");
    const header = Buffer.alloc(4);
    try {
      await handle.read(header, 0, 4, 0);
    } finally {
      await handle.close();
    }
    if (
      /\.(?:node|dylib|so)$/u.test(entry.path) ||
      magic.has(header.toString("hex"))
    )
      result.push(entry.path);
  }
  return result;
}

export async function verifyCompressedWorkerService(root) {
  await assertSafeDirectory(root);
  if (
    (await readdir(root)).sort().join("|") !==
    "archive.json|service-manifest.json|service-payload.zip"
  )
    throw new Error("WORKER_SERVICE_ARCHIVE_INVALID");
  for (const name of [
    "archive.json",
    "service-manifest.json",
    "service-payload.zip",
  ]) {
    const info = await lstat(join(root, name));
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.mode & 0o022 ||
      info.size > 128 * 1024 ** 2
    )
      throw new Error("WORKER_SERVICE_ARCHIVE_INVALID");
  }
  const archive = JSON.parse(
    await readFile(join(root, "archive.json"), "utf8"),
  );
  if (
    Object.keys(archive).sort().join("|") !==
      "bytes|filename|schema_version|sha256" ||
    archive.schema_version !== 1 ||
    archive.filename !== "service-payload.zip" ||
    !Number.isSafeInteger(archive.bytes) ||
    archive.bytes < 1 ||
    archive.bytes > 128 * 1024 ** 2 ||
    !SHA256.test(archive.sha256 ?? "")
  )
    throw new Error("WORKER_SERVICE_ARCHIVE_INVALID");
  const bytes = await readFile(join(root, archive.filename));
  if (
    bytes.length !== archive.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== archive.sha256
  )
    throw new Error("WORKER_SERVICE_ARCHIVE_HASH_INVALID");
  const service = JSON.parse(
    await readFile(join(root, "service-manifest.json"), "utf8"),
  );
  if (
    service.schema_version !== 1 ||
    service.platform !== "darwin" ||
    service.architecture !== "arm64" ||
    service.api_version !== 1 ||
    !VERSION.test(service.worker_version ?? "") ||
    !Array.isArray(service.entries) ||
    service.entries.length > 50000 ||
    entriesDigest(service.entries) !== service.payload_sha256
  )
    throw new Error("WORKER_SERVICE_MANIFEST_INVALID");
  assertRequired(service.entries);
  const expected = service.entries
    .map((entry) => entry.path + (entry.kind === "directory" ? "/" : ""))
    .sort();
  const listing = await execute(
    "/usr/bin/unzip",
    ["-Z1", join(root, archive.filename)],
    {
      timeout: 60000,
      maxBuffer: 4 * 1024 ** 2,
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
    },
  );
  const actual = listing.stdout.trimEnd().split("\n").sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("WORKER_SERVICE_ARCHIVE_INVENTORY_INVALID");
  return { service, archive };
}

export async function inventoryWorkerService(root) {
  const entries = [];
  async function walk(directory) {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const full = join(directory, name);
      const path = relative(root, full).split(sep).join("/");
      if (path === "service-manifest.json") continue;
      if (FORBIDDEN.test(name))
        throw new Error("WORKER_PAYLOAD_FORBIDDEN_FILE");
      const info = await lstat(full);
      if (info.isSymbolicLink()) {
        const target = await readlink(full);
        const destination = resolve(dirname(full), target);
        if (
          isAbsolute(target) ||
          target.includes("\0") ||
          !destination.startsWith(`${resolve(root)}${sep}`)
        )
          throw new Error("WORKER_PAYLOAD_SYMLINK_UNSAFE");
        entries.push({ path, kind: "symlink", target });
      } else if (info.isDirectory()) {
        if (info.mode & 0o022)
          throw new Error("WORKER_PAYLOAD_PERMISSIONS_INVALID");
        entries.push({ path, kind: "directory", mode: info.mode & 0o777 });
        await walk(full);
      } else if (info.isFile()) {
        if (
          info.nlink !== 1 ||
          info.mode & 0o022 ||
          info.size > 128 * 1024 ** 2
        )
          throw new Error("WORKER_PAYLOAD_FILE_UNSAFE");
        entries.push({
          path,
          kind: "file",
          bytes: info.size,
          mode: info.mode & 0o777,
          sha256: createHash("sha256")
            .update(await readFile(full))
            .digest("hex"),
        });
      } else throw new Error("WORKER_PAYLOAD_ENTRY_UNSAFE");
    }
  }
  await assertSafeDirectory(root);
  await walk(root);
  return entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

export async function verifyWorkerService(root) {
  const path = join(root, "service-manifest.json");
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.mode & 0o022 ||
    info.size > 16 * 1024 ** 2
  )
    throw new Error("WORKER_SERVICE_MANIFEST_INVALID");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (
    manifest.schema_version !== 1 ||
    manifest.platform !== "darwin" ||
    manifest.architecture !== "arm64" ||
    manifest.api_version !== 1 ||
    !VERSION.test(manifest.worker_version ?? "") ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length > 50000 ||
    !SHA256.test(manifest.payload_sha256 ?? "")
  )
    throw new Error("WORKER_SERVICE_MANIFEST_INVALID");
  const actual = await inventoryWorkerService(root);
  assertRequired(actual);
  if (
    entriesDigest(actual) !== manifest.payload_sha256 ||
    JSON.stringify(actual) !== JSON.stringify(manifest.entries)
  )
    throw new Error("WORKER_SERVICE_INVENTORY_MISMATCH");
  const packageInfo = JSON.parse(
    await readFile(join(root, "app", "package.json"), "utf8"),
  );
  if (
    packageInfo.name !== "@music-mute/worker" ||
    packageInfo.version !== manifest.worker_version
  )
    throw new Error("WORKER_SERVICE_VERSION_MISMATCH");
  return manifest;
}

function assertRequired(entries) {
  const files = new Set(
    entries.filter((entry) => entry.kind === "file").map((entry) => entry.path),
  );
  if (REQUIRED.some((path) => !files.has(path)))
    throw new Error("WORKER_SERVICE_INCOMPLETE");
}

async function normalizePermissions(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await chmod(path, 0o755);
      await normalizePermissions(path);
    } else if (entry.isFile()) {
      const executable = /\/dist\/src\/cli\/(?:main|app-control)\.js$/u.test(
        path,
      );
      await chmod(path, executable ? 0o755 : 0o644);
    }
  }
  await chmod(root, 0o755);
}

async function assertSafeDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o022)
    throw new Error("WORKER_SERVICE_DIRECTORY_UNSAFE");
}

const invoked = process.argv[1];
if (invoked && resolve(invoked) === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dirname, "..");
  const workerRoot = resolve(root, "../worker");
  await execute(process.execPath, [join(workerRoot, "scripts", "build.mjs")], {
    cwd: workerRoot,
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  });
  const outputRoot = join(root, "dist", "worker", "service");
  const existing = await lstat(outputRoot).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    await verifyWorkerService(outputRoot);
    await rm(outputRoot, { recursive: true });
  }
  const manifest = await stageWorkerService({
    workerRoot,
    outputRoot,
  });
  console.log(
    `Worker service staged: ${manifest.entries.length} entries, ${manifest.payload_sha256}`,
  );
}
