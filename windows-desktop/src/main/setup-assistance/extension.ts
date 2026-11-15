import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { readPackagedResource } from "../browser/package-trust.js";
import { extensionIdFromManifest } from "../browser/registration.js";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
export const BUNDLED_EXTENSION_ID = "acmgefmmndomcpdlgnafkjbgobinllep";
export const BUNDLED_EXTENSION_FILES = [
  "_locales/ar/messages.json",
  "_locales/en/messages.json",
  "background.js",
  "content.css",
  "content.js",
  "icons/icon-128.png",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "manifest.json",
  "musicmute-mark.svg",
  "notices.txt",
  "offscreen.html",
  "offscreen.js",
  "popup.css",
  "popup.html",
  "popup.js",
  "privacy.css",
  "privacy.html",
  "privacy.js",
].sort();
export async function verifiedExtensionFolder(
  resources: string,
  signal: AbortSignal,
): Promise<string> {
  const folder = join(resources, "extension"),
    before = await lstat(folder, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink())
    throw new Error("SETUP_ASSISTANCE_UNAVAILABLE");
  const raw = parseStrictJson(
    new TextDecoder("utf-8", { fatal: true }).decode(
      await readPackagedResource(join(folder, "inventory.json"), 32768),
    ),
    32768,
  ) as { version?: unknown; extensionId?: unknown; entries?: unknown };
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join() !== "entries,extensionId,version" ||
    raw.version !== 1 ||
    raw.extensionId !== BUNDLED_EXTENSION_ID ||
    !Array.isArray(raw.entries) ||
    raw.entries.length !== BUNDLED_EXTENSION_FILES.length
  )
    throw new Error("SETUP_ASSISTANCE_UNAVAILABLE");
  const expected = new Set(BUNDLED_EXTENSION_FILES);
  let total = 0;
  for (const unknownEntry of raw.entries) {
    signal.throwIfAborted();
    const entry = unknownEntry as {
      path?: unknown;
      bytes?: unknown;
      sha256?: unknown;
    };
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join() !== "bytes,path,sha256" ||
      typeof entry.path !== "string" ||
      !expected.delete(entry.path) ||
      !Number.isSafeInteger(entry.bytes) ||
      (entry.bytes as number) < 1 ||
      (entry.bytes as number) > 8 * 1024 ** 2 ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256)
    )
      throw new Error("SETUP_ASSISTANCE_UNAVAILABLE");
    total += entry.bytes as number;
    if (total > 32 * 1024 ** 2) throw new Error("SETUP_ASSISTANCE_UNAVAILABLE");
    const bytes = await readPackagedResource(
      join(folder, ...entry.path.split("/")),
      8 * 1024 ** 2,
    );
    if (
      bytes.length !== entry.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== entry.sha256
    )
      throw new Error("SETUP_ASSISTANCE_UNAVAILABLE");
    if (entry.path === "manifest.json") {
      const manifest = parseStrictJson(bytes.toString("utf8"), 32768);
      if (extensionIdFromManifest(manifest) !== BUNDLED_EXTENSION_ID)
        throw new Error("SETUP_ASSISTANCE_UNAVAILABLE");
    }
  }
  const names: string[] = [];
  const visit = async (directory: string, prefix: string) => {
    for (const name of await readdir(directory)) {
      signal.throwIfAborted();
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = await lstat(join(directory, name));
      if (stat.isSymbolicLink())
        throw new Error("SETUP_ASSISTANCE_UNAVAILABLE");
      if (stat.isDirectory()) {
        if (
          !["_locales", "_locales/ar", "_locales/en", "icons"].includes(
            relative,
          )
        )
          throw new Error("SETUP_ASSISTANCE_UNAVAILABLE");
        await visit(join(directory, name), relative);
      } else {
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          ![...BUNDLED_EXTENSION_FILES, "inventory.json"].includes(relative)
        )
          throw new Error("SETUP_ASSISTANCE_UNAVAILABLE");
        names.push(relative);
      }
    }
  };
  await visit(folder, "");
  const after = await lstat(folder, { bigint: true });
  if (
    names.length !== BUNDLED_EXTENSION_FILES.length + 1 ||
    after.isSymbolicLink() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.birthtimeNs !== before.birthtimeNs
  )
    throw new Error("SETUP_ASSISTANCE_UNAVAILABLE");
  signal.throwIfAborted();
  return folder;
}
