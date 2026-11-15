import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  childEnvironment,
  ensureLogFile,
  fileDigest,
  verifyPinnedFile,
} from "./backend-logs.mjs";
import { createPrivateProcessLog } from "./private-process-log.mjs";

const defaultRoot = fileURLToPath(new URL("../../", import.meta.url));
const patchFile = fileURLToPath(
  new URL("./vector-file-readiness.patch", import.meta.url),
);
export const VECTOR_SOURCE_BUILD = Object.freeze({
  upstreamVersion: "0.59.0",
  upstreamCommit: "a3231c76bdea5078bc54c205cf89f5a1ceddbb73",
  archiveSha256:
    "a15b5011966b5b3e630821b6907d75b1db9a60bf770ff80ee6693bfbe7fefc46",
  archiveBytes: 18958475,
  patchSha256:
    "0db90a04e80ad8958204cbbf02b556d291bf553069cb4cb60c74c585611e935c",
  patchId: "chat-file-readiness-v1",
  toolchain: "1.96.1",
  protocVersion: "34.1",
  protocArchiveSha256:
    "2c7e92b8b578916937df132b3032e2e8e6c170862ecf7a8333094a6f3d03650c",
  protocArchiveBytes: 2567223,
  protocBinarySha256:
    "5c51efe5d53bb87ffb4de8beb43611757b13c98361ce1008ae590e5261f02ee2",
  features: "sources-file,sinks-file,transforms-remap",
  jobs: 2,
});

export function patchedVectorPaths(root = defaultRoot) {
  const directory = resolve(root, ".runtime/vector/source-build");
  const installed = join(directory, VECTOR_SOURCE_BUILD.patchId);
  return {
    directory,
    installed,
    binary: join(installed, "bin/vector"),
    manifest: join(installed, "manifest.json"),
    archive: join(
      directory,
      `vector-${VECTOR_SOURCE_BUILD.upstreamCommit}.tar.gz`,
    ),
    target: join(directory, "target"),
    protocArchive: join(directory, "protoc-34.1-osx-aarch_64.zip"),
    protocDirectory: join(directory, "protoc-34.1"),
    protocBinary: join(directory, "protoc-34.1/bin/protoc"),
    log: join(directory, "build.log"),
  };
}

async function safeRegular(path, maxBytes = Infinity) {
  let parent = dirname(path);
  while (true) {
    const value = await lstat(parent);
    if (!value.isDirectory() || value.isSymbolicLink())
      throw new Error("Unsafe Vector build path.");
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size > maxBytes
  )
    throw new Error("Unsafe Vector build file.");
  return info;
}

export function matchesVectorBuildProvenance(value) {
  return (
    !!value &&
    Object.entries(VECTOR_SOURCE_BUILD).every(
      ([key, expected]) => value[key] === expected,
    ) &&
    value.platform === "darwin" &&
    value.arch === "arm64" &&
    /^[a-f0-9]{64}$/.test(value.binarySha256 ?? "")
  );
}

/** Read-only; an old official binary is never silently selected as a fallback. */
export async function verifiedPatchedVector(root = defaultRoot) {
  const paths = patchedVectorPaths(root);
  const info = await safeRegular(paths.manifest, 8192);
  const handle = await open(
    paths.manifest,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let manifest;
  try {
    const actual = await handle.stat();
    if (
      !actual.isFile() ||
      actual.nlink !== 1 ||
      actual.ino !== info.ino ||
      actual.dev !== info.dev ||
      actual.size > 8192
    )
      throw new Error("Invalid Vector manifest.");
    manifest = JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
  if (
    !matchesVectorBuildProvenance(manifest) ||
    !(await verifyPinnedFile(patchFile, VECTOR_SOURCE_BUILD.patchSha256)) ||
    !(await verifyPinnedFile(
      paths.archive,
      VECTOR_SOURCE_BUILD.archiveSha256,
    )) ||
    !(await verifyPinnedFile(paths.binary, manifest.binarySha256)) ||
    ((await safeRegular(paths.binary)).mode & 0o111) === 0
  )
    throw new Error("Pinned Vector source build is missing or changed.");
  return { ...paths, provenance: manifest };
}

async function downloadPinnedArchive(path, { sha256, bytes, url }) {
  if (
    await lstat(path).catch((error) =>
      error.code === "ENOENT" ? null : Promise.reject(error),
    )
  ) {
    if (!(await verifyPinnedFile(path, sha256)))
      throw new Error("Existing Vector build archive changed; preserved.");
    return;
  }
  const temporary = `${path}.${randomBytes(8).toString("hex")}.download`;
  const file = await open(temporary, "wx", 0o600);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok || !response.body)
      throw new Error("Vector source download failed.");
    let size = 0;
    const hash = createHash("sha256");
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > bytes) throw new Error("Vector source exceeds pinned size.");
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    if (size !== bytes || hash.digest("hex") !== sha256)
      throw new Error("Vector source checksum verification failed.");
    await file.close();
    await copyFile(temporary, path, constants.COPYFILE_EXCL);
    await chmod(path, 0o600);
  } finally {
    await file.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

/** Explicit install operation only. All build outputs stay private and local. */
export async function buildPatchedVector(root = defaultRoot) {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Pinned Vector source build supports macOS ARM64 only.");
  const paths = patchedVectorPaths(root);
  if (
    await lstat(paths.manifest).catch((error) =>
      error.code === "ENOENT" ? null : Promise.reject(error),
    )
  )
    return verifiedPatchedVector(root);
  await ensureLogFile(join(paths.directory, ".private-directory"));
  if (
    await lstat(paths.installed).catch((error) =>
      error.code === "ENOENT" ? null : Promise.reject(error),
    )
  )
    throw new Error(
      "An incomplete Vector installation exists; preserved for inspection.",
    );
  const lockPath = join(paths.directory, ".build.lock");
  const lock = await open(lockPath, "wx", 0o600);
  let log;
  const mask = process.umask(0o077);
  try {
    log = await createPrivateProcessLog(paths.log);
    if (!(await verifyPinnedFile(patchFile, VECTOR_SOURCE_BUILD.patchSha256)))
      throw new Error("Tracked Vector patch differs from its pinned digest.");
    await downloadPinnedArchive(paths.archive, {
      sha256: VECTOR_SOURCE_BUILD.archiveSha256,
      bytes: VECTOR_SOURCE_BUILD.archiveBytes,
      url: `https://codeload.github.com/vectordotdev/vector/tar.gz/${VECTOR_SOURCE_BUILD.upstreamCommit}`,
    });
    await downloadPinnedArchive(paths.protocArchive, {
      sha256: VECTOR_SOURCE_BUILD.protocArchiveSha256,
      bytes: VECTOR_SOURCE_BUILD.protocArchiveBytes,
      url: "https://github.com/protocolbuffers/protobuf/releases/download/v34.1/protoc-34.1-osx-aarch_64.zip",
    });
    const source = join(
      paths.directory,
      `source-${randomBytes(8).toString("hex")}`,
    );
    await mkdir(source, { mode: 0o700 });
    const env = {
      ...childEnvironment(),
      GIT_CEILING_DIRECTORIES: paths.directory,
      VECTOR_BUILD_DESC: VECTOR_SOURCE_BUILD.patchId,
      CARGO_TARGET_DIR: paths.target,
      CARGO_BUILD_JOBS: String(VECTOR_SOURCE_BUILD.jobs),
      CARGO_PROFILE_RELEASE_LTO: "false",
      CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "16",
      PROTOC: paths.protocBinary,
      PROTOC_INCLUDE: join(paths.protocDirectory, "include"),
    };
    const run = (
      command,
      args,
      { capture = false, timeoutMs = 1800000 } = {},
    ) =>
      new Promise((done, failed) => {
        const child = spawn(command, args, {
          cwd: source,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let text = "",
          outputBytes = 0,
          timedOut = false,
          force;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          force = setTimeout(() => child.kill("SIGKILL"), 5000);
          force.unref();
        }, timeoutMs);
        timer.unref();
        child.stdout.on("data", (chunk) => {
          log.append(chunk);
          outputBytes += chunk.length;
          if (capture && outputBytes <= 1024 * 1024)
            text += chunk.toString("utf8");
          else if (capture) child.kill("SIGTERM");
        });
        child.stderr.on("data", (chunk) => log.append(chunk));
        child.once("error", () => {
          clearTimeout(timer);
          clearTimeout(force);
          failed(new Error("Vector build command could not start."));
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          clearTimeout(force);
          if (
            code === 0 &&
            !timedOut &&
            (!capture || outputBytes <= 1024 * 1024)
          )
            done(text);
          else
            failed(
              new Error(
                "Vector build command failed; inspect the private build log. Existing files were preserved.",
              ),
            );
        });
      });
    const entries = (
      await run("/usr/bin/tar", ["-tzf", paths.archive], { capture: true })
    )
      .trim()
      .split("\n");
    const prefix = `vector-${VECTOR_SOURCE_BUILD.upstreamCommit}/`;
    if (
      entries.some(
        (entry) =>
          !entry.startsWith(prefix) ||
          entry.split("/").includes("..") ||
          entry.startsWith("/"),
      )
    )
      throw new Error("Unexpected Vector source archive paths.");
    await run("/usr/bin/tar", [
      "-xzf",
      paths.archive,
      "--strip-components=1",
      "--no-same-owner",
      "--no-same-permissions",
      "-C",
      source,
    ]);
    await run("/usr/bin/patch", [
      "--batch",
      "--forward",
      "-p1",
      "-i",
      patchFile,
    ]);
    if (
      !(await lstat(paths.protocDirectory).catch((error) =>
        error.code === "ENOENT" ? null : Promise.reject(error),
      ))
    ) {
      const entries = (
        await run("/usr/bin/unzip", ["-Z1", paths.protocArchive], {
          capture: true,
        })
      )
        .trim()
        .split("\n");
      if (
        entries.some(
          (entry) =>
            entry.startsWith("/") ||
            entry.split("/").includes("..") ||
            !/^(bin\/|include\/|readme\.txt$)/.test(entry),
        )
      )
        throw new Error("Unexpected pinned protoc archive paths.");
      await mkdir(paths.protocDirectory, { mode: 0o700 });
      await run("/usr/bin/unzip", [
        "-q",
        paths.protocArchive,
        "-d",
        paths.protocDirectory,
      ]);
      await chmod(paths.protocBinary, 0o700);
    }
    if (
      !(await verifyPinnedFile(
        paths.protocBinary,
        VECTOR_SOURCE_BUILD.protocBinarySha256,
      ))
    )
      throw new Error("Existing pinned protoc binary changed; preserved.");
    await run(
      "rustup",
      [
        "toolchain",
        "install",
        VECTOR_SOURCE_BUILD.toolchain,
        "--profile",
        "minimal",
      ],
      { timeoutMs: 600000 },
    );
    await run("cargo", [
      `+${VECTOR_SOURCE_BUILD.toolchain}`,
      "test",
      "--locked",
      "--release",
      "-p",
      "file-source",
      "--lib",
      "file_watcher::tests",
    ]);
    await run("cargo", [
      `+${VECTOR_SOURCE_BUILD.toolchain}`,
      "build",
      "--locked",
      "--release",
      "--no-default-features",
      "--features",
      VECTOR_SOURCE_BUILD.features,
      "--bin",
      "vector",
    ]);
    const built = join(paths.target, "release/vector");
    await safeRegular(built);
    const version = await run(built, ["--version"], {
      capture: true,
      timeoutMs: 10000,
    });
    if (
      !version.startsWith("vector 0.59.0 ") ||
      !version.includes(VECTOR_SOURCE_BUILD.patchId)
    )
      throw new Error("Built Vector did not report the pinned patch identity.");
    await mkdir(dirname(paths.binary), { recursive: true, mode: 0o700 });
    await copyFile(built, paths.binary, constants.COPYFILE_EXCL);
    await chmod(paths.binary, 0o700);
    const manifest = {
      ...VECTOR_SOURCE_BUILD,
      platform: process.platform,
      arch: process.arch,
      binarySha256: await fileDigest(paths.binary),
      builtAt: new Date().toISOString(),
      version: version.trim(),
    };
    const file = await open(paths.manifest, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(manifest, null, 2) + "\n");
    } finally {
      await file.close();
    }
    return await verifiedPatchedVector(root);
  } finally {
    process.umask(mask);
    await log?.close();
    await lock.close();
    await unlink(lockPath);
  }
}
