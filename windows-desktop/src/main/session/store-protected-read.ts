import { lstat, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function denied(): never {
  throw new Error("STORE_PROTECTED_READ_DENIED");
}
/** Read-only receiving boundary. Windows may legitimately hardlink immutable
 * package code. Stable positive links are accepted here; this grants no Store
 * origin, role, code, launch or data-write authority. Native proves those. */
export async function readStoreProtectedBytes(path: string, maximum: number) {
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 8 * 1024 ** 2 ||
    resolve(path) !== path
  )
    denied();
  const canonical = await realpath(path),
    equal = (first: string, second: string) =>
      process.platform === "win32"
        ? first.toLowerCase() === second.toLowerCase()
        : first === second;
  if (!equal(canonical, path)) denied();
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) denied();
    if (parent === dirname(parent)) break;
  }
  const named = await lstat(path, { bigint: true });
  if (
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.ino < 1n ||
    named.nlink < 1n ||
    named.nlink > 4294967295n ||
    named.size < 1n ||
    named.size > BigInt(maximum)
  )
    denied();
  const held = await open(path, "r"),
    same = (first: typeof named, second: typeof named) =>
      first.dev === second.dev &&
      first.ino === second.ino &&
      first.size === second.size &&
      first.nlink === second.nlink &&
      first.mtimeNs === second.mtimeNs &&
      first.ctimeNs === second.ctimeNs;
  try {
    const before = await held.stat({ bigint: true });
    if (!same(before, named)) denied();
    const bytes = await held.readFile();
    if (
      BigInt(bytes.length) !== before.size ||
      !same(before, await held.stat({ bigint: true })) ||
      !same(before, await lstat(path, { bigint: true })) ||
      !equal(await realpath(path), path)
    )
      denied();
    return bytes;
  } finally {
    await held.close();
  }
}
