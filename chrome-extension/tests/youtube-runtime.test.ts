import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PO_TOKEN_PROVIDER_SCRIPT_SHA256,
  PO_TOKEN_SESSION_MANAGER_SHA256,
  verifyYoutubeRuntime,
} from "../src/companion/youtube-runtime.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-youtube-identity-"));
  roots.push(root);
  const files: Array<{
    path: string;
    bytes?: number;
    sha256?: string;
    link?: string;
  }> = [
    {
      path: "provider/src/generate_once.ts",
      sha256: PO_TOKEN_PROVIDER_SCRIPT_SHA256,
      bytes: 1,
    },
    {
      path: "provider/src/session_manager.ts",
      sha256: PO_TOKEN_SESSION_MANAGER_SHA256,
      bytes: 1,
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      path: `fixture-${index}`,
      bytes: 1,
      sha256: "0".repeat(64),
    })),
  ];
  const identity = {
    schema_version: 1,
    deno_version: "2.9.7",
    provider_version: "2.0.1",
    platform: "darwin",
    arch: "arm64",
    files,
  };
  async function save() {
    await writeFile(join(root, "identity.json"), JSON.stringify(identity), {
      mode: 0o600,
    });
  }
  await save();
  return { root, identity, save };
}
describe("immutable bundled YouTube runtime", () => {
  it("pins the reviewed one-shot wrapper independently of generated manifests", async () => {
    const source = await readFile(
      new URL("../scripts/youtube-runtime/generate_once.ts", import.meta.url),
    );
    expect(createHash("sha256").update(source).digest("hex")).toBe(
      PO_TOKEN_PROVIDER_SCRIPT_SHA256,
    );
  });
  it("rejects a manifest that authorizes a modified provider wrapper", async () => {
    const { root, identity, save } = await fixture();
    identity.files[0]!.sha256 = "a".repeat(64);
    await save();
    await expect(verifyYoutubeRuntime(root, false)).rejects.toThrow(
      "PO_TOKEN_PROVIDER_INVALID",
    );
  });
  it("rejects duplicate paths before traversing the runtime", async () => {
    const { root, identity, save } = await fixture();
    identity.files[3]!.path = identity.files[2]!.path;
    await save();
    await expect(verifyYoutubeRuntime(root, false)).rejects.toThrow(
      "PO_TOKEN_PROVIDER_INVALID",
    );
  });
  it("rejects traversal paths even when they carry a pinned hash", async () => {
    const { root, identity, save } = await fixture();
    identity.files[3]!.path = "../outside";
    await save();
    await expect(verifyYoutubeRuntime(root, false)).rejects.toThrow(
      "PO_TOKEN_PROVIDER_INVALID",
    );
  });
  it("rejects a symlink outside the packaged runtime even when recorded", async () => {
    const { root, identity, save } = await fixture();
    identity.files.push({ path: "aaa/link", link: "../../outside" });
    await save();
    await mkdir(join(root, "aaa"), { mode: 0o700 });
    await symlink("../../outside", join(root, "aaa/link"));
    await expect(verifyYoutubeRuntime(root, true)).rejects.toThrow(
      "PO_TOKEN_PROVIDER_INVALID",
    );
  });
  it("rejects writable packaged resources before reading a manifest", async () => {
    const { root } = await fixture();
    await chmod(root, 0o777);
    await expect(verifyYoutubeRuntime(root, true)).rejects.toThrow(
      "PO_TOKEN_PROVIDER_INVALID",
    );
  });
});
