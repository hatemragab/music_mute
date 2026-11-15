import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
  lstat,
  symlink,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  STORE_PYTHON_NOTICE_ASSETS,
  STORE_PYTHON_NOTICE_FILES,
  STORE_PYTHON_NOTICE_METADATA,
  STORE_PYTHON_NOTICE_RUNTIME_PINS,
  STORE_PYTHON_NOTICE_SOURCE_PATH,
  buildStorePythonNoticeSources,
  stageStorePythonNotices,
  verifyStorePythonNotices,
} from "../packaging/store/python-notices.js";
import { hashStoreFile } from "../packaging/store/inventory.js";

vi.mock("../packaging/store/inventory.js", async (original) => {
  const actual =
    await original<typeof import("../packaging/store/inventory.js")>();
  return { ...actual, hashStoreFile: vi.fn(actual.hashStoreFile) };
});
const actual = await vi.importActual<
    typeof import("../packaging/store/inventory.js")
  >("../packaging/store/inventory.js"),
  component = resolve(import.meta.dirname, ".."),
  folders: string[] = [];
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
afterEach(async () => {
  vi.mocked(hashStoreFile).mockImplementation(actual.hashStoreFile);
  await Promise.all(
    folders.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture() {
  const folder = await realpath(
      await mkdtemp(join(tmpdir(), "store-python-notices-")),
    ),
    source = join(folder, "component"),
    payload = join(folder, "payload"),
    fingerprints = new Map<string, { bytes: number; sha256: string }>();
  folders.push(folder);
  await mkdir(source);
  await mkdir(payload);
  for (const row of STORE_PYTHON_NOTICE_ASSETS) {
    const path = join(source, ...row.sourcePath.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      await readFile(join(component, ...row.sourcePath.split("/"))),
      { flag: "wx" },
    );
  }
  // Only native runtime fingerprint observations are mocked. License text,
  // exclusive copies, source/payload hashes, ancestors and mutations use real IO.
  // These stubs cannot establish native metadata/DLL or Windows qualification.
  for (const row of STORE_PYTHON_NOTICE_RUNTIME_PINS) {
    const path = join(payload, ...row.path.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "synthetic native fingerprint fixture only\n", {
      flag: "wx",
    });
    fingerprints.set(path, { bytes: row.bytes, sha256: row.sha256 });
  }
  vi.mocked(hashStoreFile).mockImplementation(
    async (path) => fingerprints.get(path) ?? actual.hashStoreFile(path),
  );
  return { folder, source, payload, fingerprints };
}
describe("Store upstream Python notices (code fixtures, not native/license clearance)", () => {
  it("retains all five verbatim source texts with exact versions and public provenance, including the separate embedded library", async () => {
    expect(STORE_PYTHON_NOTICE_ASSETS).toHaveLength(5);
    expect(STORE_PYTHON_NOTICE_ASSETS.reduce((n, r) => n + r.bytes, 0)).toBe(
      24721,
    );
    for (const row of STORE_PYTHON_NOTICE_ASSETS) {
      const bytes = await readFile(
        join(component, ...row.sourcePath.split("/")),
      );
      expect(bytes.length).toBe(row.bytes);
      expect(hash(bytes)).toBe(row.sha256);
    }
    const provenance = JSON.parse(buildStorePythonNoticeSources().toString());
    expect(
      provenance.distributions.map(
        (r: { component: string; version: string }) =>
          `${r.component}@${r.version}`,
      ),
    ).toEqual(["Cython@3.3.0", "flatbuffers@25.12.19", "samplerate@0.1.0"]);
    expect(provenance.embeddedLibrary.version).toBe("0.1.9");
    expect(provenance.legalApprovalAsserted).toBe(false);
    expect(provenance.runtimeCodeChanged).toBe(false);
    expect(buildStorePythonNoticeSources().toString()).not.toMatch(
      /\/Users\/|\/private\/var\/|WindowsMutation|upstream\/.*whl/,
    );
    expect(STORE_PYTHON_NOTICE_METADATA.map((r) => r.path)).toHaveLength(3);
    expect(STORE_PYTHON_NOTICE_RUNTIME_PINS).toHaveLength(5);
  });
  it("stages exclusive byte-identical license data and independently rechecks the receiving source/payload/provenance", async () => {
    const f = await fixture(),
      before = await Promise.all(
        [...f.fingerprints.keys()].map((p) => readFile(p)),
      ),
      receipt = await stageStorePythonNotices(f.payload, f.source);
    expect(receipt.upstreamTextPreserved).toBe(true);
    expect(receipt.files).toEqual(STORE_PYTHON_NOTICE_FILES);
    for (const row of STORE_PYTHON_NOTICE_ASSETS) {
      const source = await readFile(
          join(f.source, ...row.sourcePath.split("/")),
        ),
        dest = await readFile(join(f.payload, ...row.path.split("/")));
      expect(dest).toEqual(source);
    }
    expect(
      await readFile(join(f.payload, STORE_PYTHON_NOTICE_SOURCE_PATH)),
    ).toEqual(buildStorePythonNoticeSources());
    await expect(
      verifyStorePythonNotices(f.payload, f.source),
    ).resolves.toBeUndefined();
    await expect(stageStorePythonNotices(f.payload, f.source)).rejects.toThrow(
      "STORE_PYTHON_NOTICE_INVALID",
    );
    expect(
      await Promise.all([...f.fingerprints.keys()].map((p) => readFile(p))),
    ).toEqual(before);
  });
  it("validates every source notice before copying and preserves an existing destination rather than overwriting it", async () => {
    const f = await fixture(),
      last = STORE_PYTHON_NOTICE_ASSETS.at(-1)!,
      source = join(f.source, ...last.sourcePath.split("/")),
      old = await readFile(source);
    const changed = Buffer.from(old);
    changed[0] = changed[0]! ^ 1;
    await writeFile(source, changed);
    await expect(stageStorePythonNotices(f.payload, f.source)).rejects.toThrow(
      "STORE_PYTHON_NOTICE_INVALID",
    );
    for (const row of STORE_PYTHON_NOTICE_ASSETS)
      await expect(
        lstat(join(f.payload, ...row.path.split("/"))),
      ).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(source, old);
    const destination = join(f.payload, ...last.path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, "existing notice must remain\n");
    await expect(stageStorePythonNotices(f.payload, f.source)).rejects.toThrow(
      "STORE_PYTHON_NOTICE_INVALID",
    );
    expect((await readFile(destination)).toString()).toBe(
      "existing notice must remain\n",
    );
    await expect(
      lstat(join(f.payload, ...STORE_PYTHON_NOTICE_ASSETS[0]!.path.split("/"))),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("requires current exact metadata, binding and DLL fingerprints both before staging and during independent receiving", async () => {
    const f = await fixture();
    for (const row of STORE_PYTHON_NOTICE_RUNTIME_PINS) {
      const path = join(f.payload, ...row.path.split("/")),
        pin = f.fingerprints.get(path)!;
      f.fingerprints.set(path, { ...pin, sha256: "a".repeat(64) });
      await expect(
        stageStorePythonNotices(f.payload, f.source),
      ).rejects.toThrow("STORE_PYTHON_NOTICE_INVALID");
      f.fingerprints.set(path, pin);
    }
    await stageStorePythonNotices(f.payload, f.source);
    for (const row of STORE_PYTHON_NOTICE_RUNTIME_PINS) {
      const path = join(f.payload, ...row.path.split("/")),
        pin = f.fingerprints.get(path)!;
      f.fingerprints.set(path, { ...pin, bytes: pin.bytes + 1 });
      await expect(
        verifyStorePythonNotices(f.payload, f.source),
      ).rejects.toThrow("STORE_PYTHON_NOTICE_INVALID");
      f.fingerprints.set(path, pin);
    }
  });
  it("rejects each missing or modified packaged license and changed source text even when the prior staging receipt exists", async () => {
    const f = await fixture();
    await stageStorePythonNotices(f.payload, f.source);
    for (const row of STORE_PYTHON_NOTICE_ASSETS) {
      const path = join(f.payload, ...row.path.split("/")),
        old = await readFile(path),
        changed = Buffer.from(old);
      changed[0] = changed[0]! ^ 1;
      await writeFile(path, changed);
      await expect(
        verifyStorePythonNotices(f.payload, f.source),
      ).rejects.toThrow("STORE_PYTHON_NOTICE_INVALID");
      await rm(path);
      await expect(
        verifyStorePythonNotices(f.payload, f.source),
      ).rejects.toThrow();
      await writeFile(path, old);
    }
    const path = join(
      f.source,
      ...STORE_PYTHON_NOTICE_ASSETS[0]!.sourcePath.split("/"),
    );
    await writeFile(path, "changed source\n");
    await expect(verifyStorePythonNotices(f.payload, f.source)).rejects.toThrow(
      "STORE_PYTHON_NOTICE_INVALID",
    );
  });
  it("rejects missing/altered provenance and linked source/payload notices without following or replacing them", async () => {
    const f = await fixture();
    await stageStorePythonNotices(f.payload, f.source);
    const manifest = join(f.payload, STORE_PYTHON_NOTICE_SOURCE_PATH),
      bytes = await readFile(manifest);
    await writeFile(manifest, Buffer.concat([bytes, Buffer.from(" ")]));
    await expect(verifyStorePythonNotices(f.payload, f.source)).rejects.toThrow(
      "STORE_PYTHON_NOTICE_INVALID",
    );
    await rm(manifest);
    await expect(
      verifyStorePythonNotices(f.payload, f.source),
    ).rejects.toThrow();
    await writeFile(manifest, bytes);
    const row = STORE_PYTHON_NOTICE_ASSETS[0]!,
      source = join(f.source, ...row.sourcePath.split("/")),
      dest = join(f.payload, ...row.path.split("/")),
      copy = join(f.folder, "original-license");
    await writeFile(copy, await readFile(source));
    await rm(dest);
    await symlink(copy, dest);
    await expect(verifyStorePythonNotices(f.payload, f.source)).rejects.toThrow(
      "STORE_PYTHON_NOTICE_INVALID",
    );
    await rm(dest);
    await writeFile(dest, await readFile(copy));
    await rm(source);
    await link(copy, source);
    await expect(
      verifyStorePythonNotices(f.payload, f.source),
    ).rejects.toThrow();
  });
});
