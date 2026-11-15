import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { finished } from "node:stream/promises";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { parseStoreAsarEntryPath } from "../packaging/store/audit.js";

const require = createRequire(import.meta.url);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

/** Run the installed ASAR metadata implementation with Windows path semantics.
 * This is a local archive fixture, without Windows execution or platform grants. */
async function windowsArchive() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-asar-path-test-"));
  roots.push(root);
  const app = join(root, "application"),
    bytes = Buffer.from("fixture-license\n");
  await mkdir(join(app, "dist/main"), { recursive: true });
  await mkdir(join(app, "dist/licenses"), { recursive: true });
  await writeFile(join(app, "dist/main/main.cjs"), "fixture-main");
  await writeFile(join(app, "dist/licenses/Electron.LICENSE.txt"), bytes);
  const asar = require("@electron/asar") as typeof import("@electron/asar");
  const archive = join(root, "app.asar");
  await finished(await asar.createPackage(app, archive), { cleanup: true });
  const filename = require.resolve("@electron/asar/lib/filesystem.js"),
    vendorRequire = createRequire(filename),
    exports: {
      Filesystem?: typeof import("@electron/asar/lib/filesystem.js").Filesystem;
    } = {};
  runInNewContext(await readFile(filename, "utf8"), {
    exports,
    require: (name: string) => (name === "path" ? win32 : vendorRequire(name)),
  });
  const filesystem = new exports.Filesystem!("C:\\fixture");
  const header = asar.getRawHeader(archive);
  filesystem.setHeader(header.header, header.headerSize);
  return { filesystem, bytes };
}

describe("Store ASAR archive paths", () => {
  it("reads Windows-listed nested entries with relative native lookup paths", async () => {
    const { filesystem } = await windowsArchive();
    const entries = filesystem.listFiles({ isPack: false });
    expect(entries).toContain("\\dist");
    expect(entries).toContain("\\dist\\main\\main.cjs");
    expect(() => filesystem.getFile("\\dist", false)).toThrow(
      '"\\dist" was not found in this archive',
    );
    for (const entry of entries) {
      const key = parseStoreAsarEntryPath(entry);
      expect(key).not.toContain("\\");
      expect(() =>
        filesystem.getFile(win32.join(...key.split("/")), false),
      ).not.toThrow();
    }
  });

  it("keeps POSIX archive keys canonical", () => {
    expect(parseStoreAsarEntryPath("/dist/main/main.cjs")).toBe(
      "dist/main/main.cjs",
    );
  });

  it.each([
    undefined,
    "dist/main/main.cjs",
    "/dist\\main/main.cjs",
    "\\dist/main\\main.cjs",
    "//dist/main/main.cjs",
    "\\\\dist\\main\\main.cjs",
    "\\dist\\..\\private.env",
    "/dist/./main.cjs",
    "\\C:\\dist\\main.cjs",
    "/dist/NUL.txt",
  ])("rejects ambiguous or unsafe archive entry %s", (entry) => {
    expect(() => parseStoreAsarEntryPath(entry)).toThrow();
  });

  it("uses native ASAR paths while retaining canonical licensed-asset keys", async () => {
    const { filesystem, bytes } = await windowsArchive();
    const source = await readFile(
      new URL("../packaging/inventory.cjs", import.meta.url),
      "utf8",
    );
    const start = source.indexOf(
        "async function verifyPackagedLicensedAssets(",
      ),
      end = source.indexOf("\nconst buildOnlyPackages", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    // Exercise the production function body with the real ASAR metadata reader.
    const verify = new Function(
      "require",
      "LICENSED_BUILD_ASSETS",
      "boundedInventoryFile",
      "path",
      "createHash",
      source.slice(start, end) + "\nreturn verifyPackagedLicensedAssets;",
    )(
      () => ({
        statFile: (_archive: string, name: string) =>
          filesystem.getFile(name, false),
        extractFile: (_archive: string, name: string) => {
          expect(name).toBe("dist\\licenses\\Electron.LICENSE.txt");
          filesystem.getFile(name, false);
          return bytes;
        },
      }),
      [["fixture", "licenses/Electron.LICENSE.txt"]],
      async () => bytes,
      win32,
      createHash,
    ) as (archive: string, stagedApp: string) => Promise<unknown>;
    await expect(
      verify("C:\\fixture.asar", "C:\\application"),
    ).resolves.toEqual([
      {
        path: "dist/licenses/Electron.LICENSE.txt",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ]);
  });
});
