import { createHash } from "node:crypto";
import { join } from "node:path";
import { rename, writeFile } from "node:fs/promises";
import { packageFile } from "../validate-assets.js";
import { PACKAGE_AUTHORITY_PROFILE } from "../../src/shared/package-build-profile.js";

export const STORE_ENGINE_PROFILE_READER = "store_code_reader.py";
export const STORE_ENGINE_PROFILE_SOURCE_MARKER =
  'PACKAGE_BUILD_PROFILE = "store-v1"\n';
type Profile = typeof PACKAGE_AUTHORITY_PROFILE;
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function invalid(): never {
  throw new Error("STORE_ENGINE_PROFILE_INVALID");
}
/** Only the supplementary reader's fixed literal changes. Engine/model/recipe
 * bytes and every other Python source remain identical to their current source.
 * The packaged receiver never selects a profile from flags or mutable data. */
export function projectStoreEngineSource(
  name: string,
  source: Uint8Array,
  profile: Profile = PACKAGE_AUTHORITY_PROFILE,
): Buffer {
  if (
    !["store-v1", "local-test-v1"].includes(profile) ||
    !/^[A-Za-z0-9_]+\.py$/u.test(name) ||
    !(source instanceof Uint8Array) ||
    source.byteLength < 1 ||
    source.byteLength > 2 * 1024 ** 2
  )
    invalid();
  const bytes = Buffer.from(source);
  if (name !== STORE_ENGINE_PROFILE_READER) return bytes;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  // Preserve old production-only source fixtures. Any real profile-bearing
  // reader, and every local-test projection, must have exactly the known marker.
  if (profile === "store-v1" && !text.includes("PACKAGE_BUILD_PROFILE"))
    return bytes;
  if (
    text.includes("\r") ||
    text.includes("\0") ||
    text.split(STORE_ENGINE_PROFILE_SOURCE_MARKER).length !== 2 ||
    [...text.matchAll(/^[\t ]*PACKAGE_BUILD_PROFILE\s*=/gmu)].length !== 1
  )
    invalid();
  return profile === "store-v1"
    ? bytes
    : Buffer.from(
        text.replace(
          STORE_ENGINE_PROFILE_SOURCE_MARKER,
          'PACKAGE_BUILD_PROFILE = "local-test-v1"\n',
        ),
      );
}
/** Fresh, owned Worker staging only. Preserve source bytes and reject already
 * transformed or independently modified staged readers before publication. */
export async function stageStoreEngineAuthorityProfile(
  root: string,
  workerRoot: string,
) {
  const original = join(
      workerRoot,
      "engine/musicmute_engine",
      STORE_ENGINE_PROFILE_READER,
    ),
    destination = join(
      root,
      "app/engine/musicmute_engine",
      STORE_ENGINE_PROFILE_READER,
    ),
    source = await packageFile(original, 2 * 1024 ** 2),
    copied = await packageFile(destination, 2 * 1024 ** 2),
    projected = projectStoreEngineSource(STORE_ENGINE_PROFILE_READER, source);
  if (!source.equals(copied)) invalid();
  if (!source.equals(projected)) {
    const temporary = destination + ".profile-staging";
    await writeFile(temporary, projected, { flag: "wx" });
    if (!(await packageFile(temporary, 2 * 1024 ** 2)).equals(projected))
      invalid();
    await rename(temporary, destination);
  }
  if (
    !(await packageFile(destination, 2 * 1024 ** 2)).equals(projected) ||
    !(await packageFile(original, 2 * 1024 ** 2)).equals(source)
  )
    invalid();
  return Object.freeze({
    profile: PACKAGE_AUTHORITY_PROFILE,
    source: { bytes: source.length, sha256: hash(source) },
    projected: { bytes: projected.length, sha256: hash(projected) },
  });
}
