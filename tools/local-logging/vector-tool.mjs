import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  unlink,
} from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  childEnvironment,
  ensureLogFile,
  fileDigest,
  verifyPinnedFile,
} from "./backend-logs.mjs";
import {
  buildPatchedVector,
  verifiedPatchedVector,
} from "./vector-source-build.mjs";

export const VECTOR_RELEASE = Object.freeze({
  version: "0.59.0",
  platform: "darwin",
  arch: "arm64",
  filename: "vector-0.59.0-arm64-apple-darwin.tar.gz",
  size: 52687645,
  sha256: "6f0cd290c90ea2cfc7cb3c10eca32fc897f0b958b60d48ad2867a91d5585363c",
  url: "https://github.com/vectordotdev/vector/releases/download/v0.59.0/vector-0.59.0-arm64-apple-darwin.tar.gz",
});
const defaultRoot = fileURLToPath(new URL("../../", import.meta.url));

export class VectorToolError extends Error {
  constructor(message) {
    super(message);
    this.name = "VectorToolError";
  }
}

export function vectorPaths(root = defaultRoot) {
  const installDir = resolve(root, ".runtime/vector");
  const versionDir = join(installDir, `vector-${VECTOR_RELEASE.version}`);
  return {
    installDir,
    versionDir,
    binary: join(versionDir, "bin/vector"),
    archive: join(installDir, VECTOR_RELEASE.filename),
    manifest: join(installDir, `vector-${VECTOR_RELEASE.version}.json`),
    processLog: join(installDir, "install.log"),
  };
}

async function safeAncestors(path) {
  const parent = dirname(path);
  let current = parse(parent).root;
  for (const part of relative(current, parent).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new VectorToolError(
          "Vector runtime directories must be regular directories without links.",
        );
    }
  }
}

async function privateDirectory(path) {
  await safeAncestors(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new VectorToolError(
      "Existing Vector runtime directory is unsafe; it was preserved.",
    );
  await chmod(path, 0o700);
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function readManifest(path) {
  await safeAncestors(path);
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size > 8192
  )
    throw new Error();
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const actual = await file.stat();
    if (
      !actual.isFile() ||
      actual.nlink !== 1 ||
      actual.ino !== info.ino ||
      actual.dev !== info.dev ||
      actual.size > 8192
    )
      throw new Error();
    return JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
}

/** No writes, installation, network requests, or service starts. */
export async function verifiedOfficialVector(root = defaultRoot) {
  const paths = vectorPaths(root);
  try {
    await safeAncestors(paths.binary);
    const manifest = await readManifest(paths.manifest);
    if (
      manifest.version !== VECTOR_RELEASE.version ||
      manifest.platform !== VECTOR_RELEASE.platform ||
      manifest.arch !== VECTOR_RELEASE.arch ||
      manifest.archiveSha256 !== VECTOR_RELEASE.sha256 ||
      !/^[a-f0-9]{64}$/.test(manifest.binarySha256)
    )
      throw new Error();
    if (
      !(await verifyPinnedFile(paths.archive, VECTOR_RELEASE.sha256)) ||
      !(await verifyPinnedFile(paths.binary, manifest.binarySha256))
    )
      throw new Error();
    const binary = await lstat(paths.binary);
    if ((binary.mode & 0o111) === 0) throw new Error();
    return paths;
  } catch {
    throw new VectorToolError(
      "The pinned Vector installation is missing or changed. Run node scripts/vector-tool.mjs install; existing files are preserved.",
    );
  }
}

/** Keep the official artifact intact, but require the verified idle-read fix. */
export async function verifiedVector(root = defaultRoot) {
  const original = await verifiedOfficialVector(root);
  try {
    const patched = await verifiedPatchedVector(root);
    return {
      ...original,
      officialBinary: original.binary,
      binary: patched.binary,
      sourceBuild: patched.provenance,
    };
  } catch {
    throw new VectorToolError(
      "The pinned Vector file-readiness build is missing or changed. Run node scripts/vector-tool.mjs install; existing files are preserved.",
    );
  }
}

export function isPinnedVectorVersion(output) {
  return /^vector 0\.59\.0(?:\s|$)/.test(output.trim());
}

function commandOutput(command, args, paths, timeoutMs = 120_000) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: paths.installDir,
      env: childEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    let bytes = 0;
    let failure;
    const stop = () => {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 2000);
      force.unref();
    };
    const timer = setTimeout(() => {
      failure = true;
      stop();
    }, timeoutMs);
    timer.unref();
    for (const output of [child.stdout, child.stderr])
      output.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          failure = true;
          stop();
        } else chunks.push(chunk);
      });
    child.once("error", () => {
      clearTimeout(timer);
      rejectCommand(
        new VectorToolError("Vector installation command could not start."),
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !failure)
        resolveCommand(Buffer.concat(chunks).toString("utf8"));
      else
        rejectCommand(
          new VectorToolError(
            "Vector installation command failed; existing files were preserved.",
          ),
        );
    });
  });
}

async function downloadArchive(paths) {
  if (await exists(paths.archive)) {
    if (!(await verifyPinnedFile(paths.archive, VECTOR_RELEASE.sha256)))
      throw new VectorToolError(
        "Existing Vector archive failed its pinned checksum; it was preserved.",
      );
    return;
  }
  const temporary = `${paths.archive}.${randomBytes(8).toString("hex")}.download`;
  let file;
  try {
    const response = await fetch(VECTOR_RELEASE.url, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok || !response.body)
      throw new VectorToolError(
        "Could not download the pinned official Vector release.",
      );
    file = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > VECTOR_RELEASE.size)
        throw new VectorToolError("Vector archive exceeded its pinned size.");
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    if (
      size !== VECTOR_RELEASE.size ||
      hash.digest("hex") !== VECTOR_RELEASE.sha256
    )
      throw new VectorToolError(
        "Official Vector archive failed pinned checksum verification.",
      );
    await file.close();
    file = undefined;
    if (!(await verifyPinnedFile(temporary, VECTOR_RELEASE.sha256)))
      throw new VectorToolError(
        "Written Vector archive failed checksum verification.",
      );
    await link(temporary, paths.archive);
  } finally {
    await file?.close().catch(() => {});
    // Remove only the random temporary download created by this invocation.
    await unlink(temporary).catch(() => {});
  }
}

async function privateTree(path) {
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    (!info.isDirectory() && !info.isFile()) ||
    (info.isFile() && info.nlink !== 1)
  )
    throw new VectorToolError(
      "The pinned Vector archive contained an unexpected file type.",
    );
  await chmod(path, info.isDirectory() ? 0o700 : 0o600);
  if (info.isDirectory())
    for (const name of await readdir(path)) await privateTree(join(path, name));
}

async function installOfficialVector(root = defaultRoot) {
  if (
    process.platform !== VECTOR_RELEASE.platform ||
    process.arch !== VECTOR_RELEASE.arch
  )
    throw new VectorToolError(
      "The pinned Vector installer currently supports macOS ARM64 only.",
    );
  const paths = vectorPaths(root);
  await privateDirectory(resolve(root, ".runtime"));
  await privateDirectory(paths.installDir);
  if (await exists(paths.manifest)) return verifiedOfficialVector(root);
  if (await exists(paths.versionDir))
    throw new VectorToolError(
      "An existing Vector version directory has no verified manifest; it was preserved.",
    );
  const lockPath = join(paths.installDir, ".install.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    throw new VectorToolError(
      "A Vector installation lock exists; inspect it before retrying.",
    );
  }
  try {
    await ensureLogFile(paths.processLog, { createParent: false });
    await downloadArchive(paths);
    const rawEntries = (
      await commandOutput("/usr/bin/tar", ["-tzf", paths.archive], paths)
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    const dotPrefix = rawEntries[0]?.startsWith("./") === true;
    if (rawEntries.some((entry) => entry.startsWith("./") !== dotPrefix))
      throw new VectorToolError(
        "The pinned Vector archive layout is inconsistent; it was preserved.",
      );
    const entries = rawEntries.map((entry) => entry.replace(/^\.\//, ""));
    // BSD tar counts the leading ./ as a component when stripping paths.
    const stripComponents = dotPrefix ? 2 : 1;
    const top = entries[0]?.split("/")[0];
    if (
      !top ||
      entries.some(
        (entry) =>
          entry.startsWith("/") ||
          entry.split("/").includes("..") ||
          entry.split("/")[0] !== top,
      ) ||
      !entries.includes(`${top}/bin/vector`)
    )
      throw new VectorToolError(
        "The pinned Vector archive layout is unexpected; it was preserved.",
      );
    // A new directory and no overwrite flag preserve unrelated or interrupted installs.
    await mkdir(paths.versionDir, { mode: 0o700 });
    await commandOutput(
      "/usr/bin/tar",
      [
        "-xzf",
        paths.archive,
        `--strip-components=${stripComponents}`,
        "--no-same-owner",
        "--no-same-permissions",
        "-C",
        paths.versionDir,
      ],
      paths,
    );
    await privateTree(paths.versionDir);
    await chmod(paths.binary, 0o700);
    const version = await commandOutput(
      paths.binary,
      ["--version"],
      paths,
      10_000,
    );
    if (!isPinnedVectorVersion(version))
      throw new VectorToolError(
        "Extracted Vector did not report the pinned stable version.",
      );
    const binarySha256 = await fileDigest(paths.binary);
    const manifest = await open(paths.manifest, "wx", 0o600);
    try {
      await manifest.writeFile(
        `${JSON.stringify({ version: VECTOR_RELEASE.version, platform: VECTOR_RELEASE.platform, arch: VECTOR_RELEASE.arch, archiveSha256: VECTOR_RELEASE.sha256, binarySha256 }, null, 2)}\n`,
      );
    } finally {
      await manifest.close();
    }
    const log = await open(
      paths.processLog,
      constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await log.writeFile(
        `${new Date().toISOString()} installed Vector ${VECTOR_RELEASE.version}; archive and binary verified\n`,
      );
    } finally {
      await log.close();
    }
    return await verifiedOfficialVector(root);
  } catch (error) {
    if (error instanceof VectorToolError) throw error;
    throw new VectorToolError(
      "Vector installation failed; existing files were preserved. Inspect the private runtime directory before retrying.",
    );
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export async function installVector(root = defaultRoot) {
  await installOfficialVector(root);
  try {
    await buildPatchedVector(root);
  } catch (error) {
    throw new VectorToolError(
      error instanceof Error &&
        error.message.startsWith("Existing Vector source")
        ? error.message
        : "The pinned Vector source build failed; inspect its private build log. Existing files were preserved.",
    );
  }
  return verifiedVector(root);
}

export async function main(args = process.argv.slice(2), root = defaultRoot) {
  if (args.length !== 1 || !["install", "verify"].includes(args[0]))
    throw new VectorToolError(
      "Use node scripts/vector-tool.mjs install|verify.",
    );
  const paths =
    args[0] === "install"
      ? await installVector(root)
      : await verifiedVector(root);
  process.stdout.write(
    `Vector ${VECTOR_RELEASE.version} ${args[0] === "install" ? "installed" : "verified"} locally.\n`,
  );
  return paths;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof VectorToolError ? error.message : "Vector tool failed."}\n`,
    );
    process.exitCode = 1;
  });
}
