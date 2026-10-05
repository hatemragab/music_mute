import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

export const DENO_VERSION = "2.9.7";
export const PO_TOKEN_PROVIDER_VERSION = "2.0.1";
export const PO_TOKEN_PROVIDER_SCRIPT_SHA256 =
  "718ba412feecbc67d423c30048fb9a5066c195a610773208abfe1912f6f10b7c";
export const PO_TOKEN_SESSION_MANAGER_SHA256 =
  "31834151c54c2cb4550f6c3d2f4c72f2e3d6ff381d3bd7ca2f29922bf8abadb0";
export const PO_TOKEN_PROVIDER_WHEEL = {
  file: "bgutil_ytdlp_pot_provider-2.0.1-py3-none-any.whl",
  version: PO_TOKEN_PROVIDER_VERSION,
  bytes: 12777,
  sha256: "ff6c2e85443e0777e2483e4a5ef2084ca745a1dd3cc07cf355ddd3a77bd882e8",
} as const;

export async function verifyYoutubeRuntime(
  directory: string,
  packaged: boolean,
): Promise<void> {
  const invalid = (): never => {
    throw new Error("PO_TOKEN_PROVIDER_INVALID");
  };
  if (!isAbsolute(directory)) invalid();
  const root = await lstat(directory);
  const mask = packaged ? 0o022 : 0o077;
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    root.mode & mask ||
    (!packaged && root.uid !== process.getuid?.())
  )
    invalid();
  const manifestPath = join(directory, "identity.json");
  const record = await lstat(manifestPath);
  if (
    !record.isFile() ||
    record.isSymbolicLink() ||
    record.nlink !== 1 ||
    record.size > 8 * 1024 * 1024 ||
    record.mode & mask
  )
    invalid();
  const identity = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  if (
    identity.schema_version !== 1 ||
    identity.deno_version !== DENO_VERSION ||
    identity.provider_version !== PO_TOKEN_PROVIDER_VERSION ||
    identity.platform !== "darwin" ||
    identity.arch !== "arm64" ||
    !Array.isArray(identity.files) ||
    identity.files.length > 30000 ||
    identity.files.length < 10
  )
    invalid();
  const expected = new Map<string, Record<string, unknown>>();
  for (const raw of identity.files as Record<string, unknown>[]) {
    if (
      !raw ||
      typeof raw !== "object" ||
      typeof raw.path !== "string" ||
      raw.path.length > 1024 ||
      isAbsolute(raw.path) ||
      raw.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      expected.has(raw.path)
    )
      invalid();
    expected.set(raw.path as string, raw);
  }
  if (
    expected.get("provider/src/generate_once.ts")?.sha256 !==
      PO_TOKEN_PROVIDER_SCRIPT_SHA256 ||
    expected.get("provider/src/session_manager.ts")?.sha256 !==
      PO_TOKEN_SESSION_MANAGER_SHA256
  )
    invalid();
  let checked = 0;
  async function visit(path: string, prefix = ""): Promise<void> {
    const entries = await readdir(path);
    for (const name of entries) {
      const key = `${prefix}${name}`,
        full = join(path, name);
      if (key === "identity.json") continue;
      const info = await lstat(full);
      if (info.mode & 0o022 || (!packaged && info.uid !== process.getuid?.()))
        invalid();
      if (info.isDirectory() && !info.isSymbolicLink()) {
        await visit(full, `${key}/`);
        continue;
      }
      const recorded = expected.get(key);
      if (!recorded) return invalid();
      if (info.isSymbolicLink()) {
        const target = await readlink(full);
        if (
          recorded?.link !== target ||
          !resolve(path, target).startsWith(`${resolve(directory)}${sep}`)
        )
          invalid();
      } else {
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          info.size !== recorded?.bytes ||
          typeof recorded.sha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(recorded.sha256)
        )
          invalid();
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(full)) hash.update(chunk);
        if (hash.digest("hex") !== recorded.sha256) invalid();
      }
      checked++;
    }
  }
  await visit(directory);
  if (
    checked !== expected.size ||
    !expected.has("bin/deno") ||
    !expected.has("provider/src/generate_once.ts") ||
    !expected.has("provider/src/session_manager.ts") ||
    !expected.has("provider/deno.lock")
  )
    invalid();
}

export function tokenProviderCheckArguments(
  directory: string,
  cache: string,
): string[] {
  return [
    "run",
    "--cached-only",
    "--frozen",
    "--no-check",
    "--deny-net",
    "--allow-env",
    `--allow-read=${directory.replaceAll(",", ",,")},${cache.replaceAll(",", ",,")}`,
    `--allow-ffi=${join(directory, "provider/node_modules").replaceAll(",", ",,")}`,
    `--allow-write=${cache.replaceAll(",", ",,")}`,
    "--config",
    join(directory, "provider/deno.json"),
    join(directory, "provider/src/generate_once.ts"),
    "--musicmute-check",
  ];
}
