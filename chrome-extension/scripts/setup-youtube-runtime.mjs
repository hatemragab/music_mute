import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  fileDigest,
  refreshYoutubeRuntimeIdentity,
  YOUTUBE_RUNTIME_PINS,
} from "./youtube-runtime-artifacts.mjs";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const target =
  process.env.MUSICMUTE_YOUTUBE_RUNTIME_TARGET ??
  join(root, "output/youtube-runtime.noindex");
const staging = `${target}.${randomUUID()}.staging`;
const allowedHosts = new Set([
  "github.com",
  "codeload.github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);
async function download(pin, path) {
  const signal = AbortSignal.timeout(180000);
  let url = pin.url;
  let response;
  for (let index = 0; index < 6; index++) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      !allowedHosts.has(parsed.hostname) ||
      parsed.username ||
      parsed.password ||
      parsed.port
    )
      throw new Error("YOUTUBE_RUNTIME_SOURCE_INVALID");
    response = await fetch(url, { redirect: "manual", signal });
    if (response.status < 300 || response.status >= 400) break;
    const next = response.headers.get("location");
    await response.body?.cancel();
    if (!next) throw new Error("YOUTUBE_RUNTIME_SOURCE_INVALID");
    url = new URL(next, url).href;
  }
  if (!response?.ok || !response.body)
    throw new Error("YOUTUBE_RUNTIME_DOWNLOAD_FAILED");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > (pin.bytes ?? 40000000))
      throw new Error("YOUTUBE_RUNTIME_DOWNLOAD_LIMIT");
    chunks.push(Buffer.from(chunk));
  }
  const data = Buffer.concat(chunks);
  if (
    (pin.bytes && bytes !== pin.bytes) ||
    createHash("sha256").update(data).digest("hex") !== pin.sha256
  )
    throw new Error("YOUTUBE_RUNTIME_HASH_MISMATCH");
  await writeFile(path, data, { mode: 0o600, flag: "wx" });
}
async function nativeAudit(directory) {
  for (const name of await readdir(directory)) {
    const path = join(directory, name),
      info = await lstat(path);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      await nativeAudit(path);
      continue;
    }
    if (!name.endsWith(".node") && !name.endsWith(".dylib")) continue;
    const { stdout: architectures } = await exec("/usr/bin/lipo", [
      "-archs",
      path,
    ]);
    if (architectures.trim() !== "arm64")
      throw new Error("YOUTUBE_RUNTIME_ARCH_INVALID");
    const { stdout: dependencies } = await exec("/usr/bin/otool", ["-L", path]);
    for (const line of dependencies.split("\n").slice(1)) {
      const dependency = line.trim().split(" ")[0];
      if (!dependency) continue;
      if (
        dependency.startsWith("/usr/lib/") ||
        dependency.startsWith("/System/Library/")
      )
        continue;
      if (!dependency.startsWith("@loader_path/"))
        throw Object.assign(
          new Error("YOUTUBE_RUNTIME_EXTERNAL_NATIVE_DEPENDENCY"),
          { native_dependency: dependency, native_file: name },
        );
      await lstat(
        join(dirname(path), dependency.slice("@loader_path/".length)),
      );
    }
  }
}
async function makeSymlinksRelocatable(root, directory = root) {
  for (const name of await readdir(directory)) {
    const path = join(directory, name),
      info = await lstat(path);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      await makeSymlinksRelocatable(root, path);
      continue;
    }
    if (!info.isSymbolicLink()) continue;
    const target = await readlink(path);
    const resolvedTarget = resolve(dirname(path), target);
    if (!resolvedTarget.startsWith(`${resolve(root)}${sep}`))
      throw new Error("YOUTUBE_RUNTIME_LINK_INVALID");
    try {
      await lstat(resolvedTarget);
    } catch {
      throw new Error("YOUTUBE_RUNTIME_LINK_INVALID");
    }
    if (!isAbsolute(target)) continue;
    await rm(path);
    await symlink(relative(dirname(path), resolvedTarget), path);
  }
}
let owned = false;
try {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("UNSUPPORTED_PLATFORM");
  if (!isAbsolute(target) || target !== resolve(target))
    throw new Error("YOUTUBE_RUNTIME_TARGET_INVALID");
  // Rebuilding requires a new target. Never overwrite an existing runtime.
  try {
    await lstat(target);
    throw new Error("YOUTUBE_RUNTIME_TARGET_EXISTS");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(staging, { recursive: true, mode: 0o700 });
  owned = true;
  await mkdir(join(staging, "bin"), { mode: 0o700 });
  await mkdir(join(staging, "licenses"), { mode: 0o700 });
  await download(YOUTUBE_RUNTIME_PINS.deno, join(staging, "deno.zip"));
  await exec("/usr/bin/unzip", [
    "-q",
    join(staging, "deno.zip"),
    "-d",
    join(staging, "bin"),
  ]);
  const deno = join(staging, "bin/deno");
  await chmod(deno, 0o700);
  await download(
    YOUTUBE_RUNTIME_PINS.provider,
    join(staging, "licenses/bgutil-2.0.1-source.tar.gz"),
  );
  await exec("/usr/bin/tar", [
    "-xzf",
    join(staging, "licenses/bgutil-2.0.1-source.tar.gz"),
    "-C",
    staging,
  ]);
  const source = join(staging, "bgutil-ytdlp-pot-provider-2.0.1");
  const provider = join(staging, "provider");
  await rename(join(source, "server"), provider);
  await cp(
    join(source, "LICENSE"),
    join(staging, "licenses/bgutil-GPL-3.0.txt"),
  );
  await rm(source, { recursive: true });
  await cp(
    join(root, "scripts/youtube-runtime/patch-provider.py"),
    join(staging, "licenses/patch-provider.py"),
  );
  await cp(
    join(root, "scripts/youtube-runtime/generate_once.ts"),
    join(staging, "licenses/generate_once.ts"),
  );
  await exec("/usr/bin/python3", [
    "-I",
    "-B",
    "-S",
    join(root, "scripts/youtube-runtime/patch-provider.py"),
    join(provider, "src/session_manager.ts"),
  ]);
  await cp(
    join(root, "scripts/youtube-runtime/generate_once.ts"),
    join(provider, "src/generate_once.ts"),
  );
  // Remove development tools from the shipped import graph; upstream lock pins
  // every production package and integrity. Native canvas scripts stay disabled.
  const pkgPath = join(provider, "package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  delete pkg.devDependencies;
  delete pkg.scripts;
  delete pkg.allowScripts;
  await writeFile(pkgPath, JSON.stringify(pkg) + "\n", { mode: 0o600 });
  await writeFile(
    join(provider, "deno.json"),
    '{"nodeModulesDir":"manual"}\n',
    { mode: 0o600 },
  );
  const originalLock = JSON.parse(
    await readFile(join(provider, "deno.lock"), "utf8"),
  );
  const cache = join(staging, "deno-cache");
  const environment = {
    HOME: staging,
    PATH: `${join(staging, "bin")}:/usr/bin:/bin`,
    DENO_DIR: cache,
    DENO_NO_PROMPT: "1",
    DENO_NO_UPDATE_CHECK: "1",
    LANG: "en_US.UTF-8",
  };
  await exec(deno, ["install", "--prod", "--frozen=false"], {
    cwd: provider,
    env: environment,
    timeout: 180000,
    maxBuffer: 1024 * 1024,
  });
  const derivedLock = JSON.parse(
    await readFile(join(provider, "deno.lock"), "utf8"),
  );
  for (const [name, item] of Object.entries(derivedLock.npm ?? {})) {
    if (JSON.stringify(item) !== JSON.stringify(originalLock.npm?.[name]))
      throw new Error("YOUTUBE_RUNTIME_LOCK_CHANGED");
  }
  // Fetch the exact release prebuild ourselves; no lifecycle download/build fallback.
  await download(YOUTUBE_RUNTIME_PINS.canvas, join(staging, "canvas.tar.gz"));
  await exec("/usr/bin/tar", [
    "-xzf",
    join(staging, "canvas.tar.gz"),
    "-C",
    join(provider, "node_modules/canvas"),
  ]);
  await nativeAudit(join(provider, "node_modules"));
  await download(
    YOUTUBE_RUNTIME_PINS.deno_source,
    join(staging, "licenses/deno-2.9.7-source.tar.gz"),
  );
  await download(
    YOUTUBE_RUNTIME_PINS.canvas_source,
    join(staging, "licenses/canvas-3.2.3-source.tar.gz"),
  );
  await exec(
    "/usr/bin/tar",
    [
      "-xOf",
      join(staging, "licenses/deno-2.9.7-source.tar.gz"),
      "deno-2.9.7/LICENSE.md",
    ],
    { maxBuffer: 32768 },
  ).then(({ stdout }) =>
    writeFile(join(staging, "licenses/deno-MIT.txt"), stdout),
  );
  await writeFile(
    join(staging, "licenses/README.txt"),
    "Bgutil 2.0.1 GPL-3.0-only corresponding source and the applied modifications are included. Deno is MIT. JavaScript dependencies retain package manifests, sources and licenses in provider/node_modules. Canvas native prebuild is pinned and its source included; native third-party libraries retain their individual upstream license terms. Public release requires review of that native license/source closure. See docs/youtube-runtime.md.\n",
    { mode: 0o600 },
  );
  await exec(
    deno,
    ["cache", "--frozen", "--no-check", "src/generate_once.ts"],
    { cwd: provider, env: environment, timeout: 60000, maxBuffer: 128 * 1024 },
  );
  const privateCache = join(staging, "check-cache");
  await mkdir(privateCache, { mode: 0o700 });
  const args = [
    "run",
    "--cached-only",
    "--frozen",
    "--no-check",
    "--deny-net",
    "--allow-env",
    `--allow-read=${provider},${privateCache}`,
    `--allow-ffi=${join(provider, "node_modules")}`,
    `--allow-write=${privateCache}`,
    "src/generate_once.ts",
    "--musicmute-check",
  ];
  const { stdout } = await exec(deno, args, {
    cwd: provider,
    env: {
      ...environment,
      DENO_DIR: join(privateCache, "deno"),
      XDG_CACHE_HOME: privateCache,
    },
    timeout: 20000,
    maxBuffer: 32768,
  });
  if (stdout.trim() !== "ready")
    throw new Error("PO_TOKEN_PROVIDER_UNAVAILABLE");
  await rm(privateCache, { recursive: true });
  await rm(join(staging, "deno.zip"));
  await rm(join(staging, "canvas.tar.gz"));
  await rm(cache, { recursive: true });
  // The staging directory is renamed once the immutable runtime is complete,
  // so seal only existing, relocatable links that stay inside the runtime.
  await makeSymlinksRelocatable(staging);
  // Runtime caches carry no tokens; token cache is always in a disposable guest HOME.
  async function detachHardlinks(directory) {
    for (const name of await readdir(directory)) {
      const path = join(directory, name),
        info = await lstat(path);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await chmod(path, info.mode & 0o755);
        await detachHardlinks(path);
      } else if (info.isFile() && info.nlink > 1) {
        const independent = `${path}.owned-${randomUUID()}`;
        await writeFile(independent, await readFile(path), {
          mode: info.mode & 0o755,
          flag: "wx",
        });
        await rename(independent, path);
      } else if (info.isFile()) await chmod(path, info.mode & 0o755);
    }
  }
  await detachHardlinks(staging);
  await refreshYoutubeRuntimeIdentity(staging);
  await rename(staging, target);
  owned = false;
  console.log(
    JSON.stringify({
      ready: true,
      target,
      deno: "2.9.7",
      provider: "2.0.1",
      offline_provider_check: true,
      deno_sha256: await fileDigest(join(target, "bin/deno")),
    }),
  );
} catch (error) {
  if (process.env.MUSICMUTE_RUNTIME_BUILD_DEBUG === "1")
    await writeFile(
      join(root, "output/youtube-runtime-build-error.noindex.json"),
      JSON.stringify({
        code: error.code,
        stderr: error.stderr,
        stdout: error.stdout,
        message: error.message,
        native_dependency: error.native_dependency,
        native_file: error.native_file,
      }),
      { mode: 0o600 },
    );
  console.error(
    /^[A-Z_]{1,64}$/.test(error?.message ?? "")
      ? error.message
      : "YOUTUBE_RUNTIME_SETUP_FAILED",
  );
  process.exitCode = 1;
} finally {
  if (owned) await rm(staging, { recursive: true, force: true });
}
