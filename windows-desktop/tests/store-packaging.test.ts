import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  symlink,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  STORE_PRODUCTS,
  classifyStoreCode,
} from "../src/shared/store-contracts.js";
import {
  renderStoreManifest,
  storeElectronDirectoryConfig,
  STORE_ASSET_DIMENSIONS,
  STORE_CHROME_HOST_APPLICATION_ID,
} from "../packaging/store/manifest.js";
import {
  buildStoreAssets,
  buildStoreIcon,
  decodeStoreAssetPng,
  stageStoreAssets,
  STORE_ICON_SOURCE,
} from "../packaging/store/assets.js";
import {
  assertStorePayloadPath,
  createStoreCodeInventory,
  hashStoreFile,
  listStorePayload,
  parseStoreCodeInventory,
  parseStoreCodeInventoryBytes,
  safeStoreRelativePath,
} from "../packaging/store/inventory.js";
import {
  requireStorePayloadFiles,
  auditStoreSharedExtension,
  auditStoreWorkerCompiledOutputs,
  auditStorePayloadEntry,
  parseStoreGuiBuildMetadata,
  parseStoreBuildGraphs,
  parseStoreNativeMessagingManifest,
  parseStoreWorkerSourceManifest,
  StoreInputsMissing,
  STORE_WORKER_REQUIRED_FILES,
  STORE_GUI_REQUIRED_FILES,
} from "../packaging/store/audit.js";
import {
  parseStoreBuildInputs,
  parseStoreBuildInputsBytes,
  prepareStorePackages,
  normalizeStoreWorkerReleaseManifest,
  readStoreBuildInputsFile,
  verifyPreparedStorePackages,
  STORE_MAKEAPPX,
} from "../packaging/store/build.js";
import { auditStoreUploadArchive } from "../packaging/store/archive.js";
import { parseStrictJson } from "../../chrome-extension/src/shared/strict-json.js";
import {
  verifyWindowsRelease,
  writeWindowsReleaseManifest,
} from "../../worker/src/platform/windows/release-manifest.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-store-pack-test-"));
  roots.push(root);
  return root;
}
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
/** Actual stored-method ZIP bytes exercise the receiving parser, not mocks. */
function zipBytes(
  rows: readonly {
    path: string;
    content: string;
    attributes?: number;
    crc?: number;
    compressed?: boolean;
    descriptor?: boolean;
    flags?: number;
    localPath?: string;
  }[],
) {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const row of rows) {
    const name = Buffer.from(row.path),
      localName = Buffer.from(row.localPath ?? row.path),
      data = Buffer.from(row.content),
      stored = row.compressed ? deflateRawSync(data) : data,
      checksum = row.crc ?? crc32(data),
      header = Buffer.alloc(30),
      directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(row.flags ?? (row.descriptor ? 8 : 0), 6);
    header.writeUInt16LE(row.compressed ? 8 : 0, 8);
    if (!row.descriptor) {
      header.writeUInt32LE(checksum, 14);
      header.writeUInt32LE(stored.length, 18);
      header.writeUInt32LE(data.length, 22);
    }
    header.writeUInt16LE(localName.length, 26);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(row.flags ?? (row.descriptor ? 8 : 0), 8);
    directory.writeUInt16LE(row.compressed ? 8 : 0, 10);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(stored.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(row.attributes ?? 0, 38);
    directory.writeUInt32LE(offset, 42);
    const descriptor = Buffer.alloc(row.descriptor ? 16 : 0);
    if (row.descriptor) {
      descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(checksum, 4);
      descriptor.writeUInt32LE(stored.length, 8);
      descriptor.writeUInt32LE(data.length, 12);
    }
    local.push(header, localName, stored, descriptor);
    central.push(directory, name);
    offset +=
      header.length + localName.length + stored.length + descriptor.length;
  }
  const tail = Buffer.alloc(22),
    directories = Buffer.concat(central);
  tail.writeUInt32LE(0x06054b50);
  tail.writeUInt16LE(rows.length, 8);
  tail.writeUInt16LE(rows.length, 10);
  tail.writeUInt32LE(directories.length, 12);
  tail.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directories, tail]);
}
function inventory(
  entries = [
    { path: "worker/runtime/node/node.exe", bytes: 10, sha256: "a".repeat(64) },
  ],
) {
  return {
    version: 1,
    role: "worker",
    packageVersion: "0.1.3.0",
    protocolAbi: 1,
    appVersion: "0.1.3",
    buildNumber: 1,
    entries,
  };
}

describe("actual independent main package manifests", () => {
  it.each(["packaged-classic-v1", "unvirtualized-candidate-v1"] as const)(
    "binds the SDK-required console multi-instance attributes to the hidden Chrome alias owner (%s)",
    (namespaceProfile) => {
      const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
        JSDOM: new (
          xml: string,
          options: { contentType: "application/xml" },
        ) => { window: { document: Document; close(): void } };
      };
      const dom = new JSDOM(
        renderStoreManifest("gui", {
          packageVersion: "0.1.0.0",
          appBuildNumber: 1,
          namespaceProfile,
        }),
        { contentType: "application/xml" },
      );
      try {
        const foundation =
            "http://schemas.microsoft.com/appx/manifest/foundation/windows10",
          desktop4 =
            "http://schemas.microsoft.com/appx/manifest/desktop/windows10/4",
          uap = "http://schemas.microsoft.com/appx/manifest/uap/windows10",
          uap5 = "http://schemas.microsoft.com/appx/manifest/uap/windows10/5",
          uap10 = "http://schemas.microsoft.com/appx/manifest/uap/windows10/10";
        const applications = Array.from(
          dom.window.document.getElementsByTagNameNS(foundation, "Application"),
        );
        expect(applications).toHaveLength(2);
        const gui = applications.find(
          (entry) =>
            entry.getAttribute("Id") === STORE_PRODUCTS.gui.applicationId,
        )!;
        const host = applications.find(
          (entry) =>
            entry.getAttribute("Id") === STORE_CHROME_HOST_APPLICATION_ID,
        )!;
        const runtimeBehavior =
          namespaceProfile === "packaged-classic-v1"
            ? "packagedClassicApp"
            : "win32App";
        for (const application of applications) {
          expect(application.hasAttribute("EntryPoint")).toBe(false);
          expect(application.getAttributeNS(uap10, "RuntimeBehavior")).toBe(
            runtimeBehavior,
          );
          expect(application.getAttributeNS(uap10, "TrustLevel")).toBe(
            "mediumIL",
          );
        }
        expect(gui.getAttribute("Executable")).toBe(
          "app\\MusicMuteSession.exe",
        );
        expect(
          applications.map((entry) => entry.getAttribute("Executable")).sort(),
        ).toEqual([
          "app\\MusicMuteChromeHost.exe",
          "app\\MusicMuteSession.exe",
        ]);
        expect(classifyStoreCode("gui", "MusicMuteSession.exe")).toBe(
          "gui-session-proxy",
        );
        expect(classifyStoreCode("gui", "MusicMute Local.exe")).toBe(
          "desktop-main",
        );
        expect(STORE_GUI_REQUIRED_FILES).toEqual(
          expect.arrayContaining([
            "MusicMute Local.exe",
            "MusicMuteSession.exe",
          ]),
        );
        expect(gui.getAttributeNS(desktop4, "Subsystem")).toBeNull();
        expect(
          gui.getAttributeNS(desktop4, "SupportsMultipleInstances"),
        ).toBeNull();
        expect(
          gui.getElementsByTagNameNS(uap5, "AppExecutionAlias"),
        ).toHaveLength(0);
        expect(
          gui.getElementsByTagNameNS(uap, "Protocol")[0]!.getAttribute("Name"),
        ).toBe("musicmute-local");
        expect(host.getAttribute("Executable")).toBe(
          "app\\MusicMuteChromeHost.exe",
        );
        expect(host.getAttributeNS(desktop4, "Subsystem")).toBe("console");
        expect(host.getAttributeNS(desktop4, "SupportsMultipleInstances")).toBe(
          "true",
        );
        expect(host.getAttributeNS(uap10, "TrustLevel")).toBe("mediumIL");
        expect(host.getAttributeNS(uap10, "RuntimeBehavior")).toBe(
          runtimeBehavior,
        );
        expect(
          host
            .getElementsByTagNameNS(uap, "VisualElements")[0]!
            .getAttribute("AppListEntry"),
        ).toBe("none");
        const alias = host.getElementsByTagNameNS(
          uap5,
          "AppExecutionAlias",
        )[0]!;
        const aliasExtension = alias.parentElement!;
        expect(aliasExtension.hasAttribute("EntryPoint")).toBe(false);
        expect(aliasExtension.getAttributeNS(uap10, "RuntimeBehavior")).toBe(
          runtimeBehavior,
        );
        expect(aliasExtension.getAttributeNS(uap10, "TrustLevel")).toBe(
          "mediumIL",
        );
        expect(alias.getAttributeNS(desktop4, "Subsystem")).toBe("console");
        expect(
          alias
            .getElementsByTagNameNS(uap5, "ExecutionAlias")[0]!
            .getAttribute("Alias"),
        ).toBe("MusicMuteChromeHost.exe");
        const worker = new JSDOM(
          renderStoreManifest("worker", {
            packageVersion: "0.1.3.0",
            appBuildNumber: 1,
            namespaceProfile,
          }),
          { contentType: "application/xml" },
        );
        try {
          const workerApplication =
            worker.window.document.getElementsByTagNameNS(
              foundation,
              "Application",
            )[0]!;
          expect(workerApplication.getAttribute("Executable")).toBe(
            "worker\\MusicMuteWorker.exe",
          );
          expect(workerApplication.hasAttribute("EntryPoint")).toBe(false);
          expect(
            workerApplication.getAttributeNS(uap10, "RuntimeBehavior"),
          ).toBe(runtimeBehavior);
          expect(workerApplication.getAttributeNS(uap10, "TrustLevel")).toBe(
            "mediumIL",
          );
          const desktop =
            "http://schemas.microsoft.com/appx/manifest/desktop/windows10";
          const session = Array.from(
            worker.window.document.getElementsByTagNameNS(
              foundation,
              "Application",
            ),
          ).find(
            (entry) => entry.getAttribute("Id") === "MusicMuteWorkerSession",
          )!;
          expect(session.getAttribute("Executable")).toBe(
            "worker\\MusicMuteSession.exe",
          );
          expect(session.hasAttribute("EntryPoint")).toBe(false);
          expect(session.getAttributeNS(uap10, "RuntimeBehavior")).toBe(
            runtimeBehavior,
          );
          expect(session.getAttributeNS(uap10, "TrustLevel")).toBe("mediumIL");
          expect(
            workerApplication.getElementsByTagNameNS(
              "http://schemas.microsoft.com/appx/manifest/desktop/windows10",
              "Extension",
            ),
          ).toHaveLength(0);
          const startup = session.getElementsByTagNameNS(
            desktop,
            "Extension",
          )[0]!;
          expect(startup.getAttribute("Category")).toBe("windows.startupTask");
          expect(startup.getAttribute("Executable")).toBe(
            "worker\\MusicMuteSession.exe",
          );
          expect(startup.hasAttribute("EntryPoint")).toBe(false);
          expect(startup.getAttributeNS(uap10, "RuntimeBehavior")).toBe(
            runtimeBehavior,
          );
          expect(startup.getAttributeNS(uap10, "TrustLevel")).toBe("mediumIL");
          expect(
            worker.window.document.getElementsByTagNameNS(
              foundation,
              "Application",
            ),
          ).toHaveLength(2);
          expect(
            worker.window.document.getElementsByTagNameNS(
              uap5,
              "AppExecutionAlias",
            ),
          ).toHaveLength(0);
        } finally {
          worker.window.close();
        }
      } finally {
        dom.window.close();
      }
    },
  );
  it.each(["gui", "worker"] as const)(
    "renders %s identity, x64 and minimum19045 without a dependent package",
    (role) => {
      const p = STORE_PRODUCTS[role],
        xml = renderStoreManifest(role, {
          packageVersion: p.packageVersion,
          appBuildNumber: 1,
          namespaceProfile: "packaged-classic-v1",
        });
      expect(xml).toContain(`Name="${p.identityName}"`);
      expect(xml).toContain(`Publisher="${p.publisher}"`);
      expect(xml).toContain('ProcessorArchitecture="x64"');
      expect(xml).toContain('MinVersion="10.0.19045.0"');
      expect(xml).toContain('RuntimeBehavior="packagedClassicApp"');
      expect(xml).not.toContain('Name="unvirtualizedResources"');
      expect(xml).not.toMatch(
        /Framework|ResourcePackage|PackageDependency|OptionalPackage/u,
      );
    },
  );
  it("keeps GUI protocol/shared Chrome alias apart from disabled Worker startup", () => {
    const gui = renderStoreManifest("gui", {
      packageVersion: "0.1.0.0",
      appBuildNumber: 1,
      namespaceProfile: "packaged-classic-v1",
    });
    const worker = renderStoreManifest("worker", {
      packageVersion: "0.1.3.0",
      appBuildNumber: 1,
      namespaceProfile: "packaged-classic-v1",
    });
    expect(gui).toContain('Name="musicmute-local"');
    expect(gui).toContain('Alias="MusicMuteChromeHost.exe"');
    expect(gui).not.toContain("windows.startupTask");
    expect(worker).toContain('Executable="worker\\MusicMuteWorker.exe"');
    expect(worker).toContain('Executable="worker\\MusicMuteSession.exe"');
    expect(worker).toContain('Enabled="false"');
    expect(worker).not.toContain("musicmute-local");
  });
  it("renders only an explicitly selected unapproved namespace candidate", () => {
    const xml = renderStoreManifest("gui", {
      packageVersion: "0.1.0.0",
      appBuildNumber: 1,
      namespaceProfile: "unvirtualized-candidate-v1",
    });
    expect(xml).toContain('RuntimeBehavior="win32App"');
    expect(xml).toContain('Name="unvirtualizedResources"');
    expect(xml).toContain("RegistryWriteVirtualization>disabled");
    expect(() =>
      renderStoreManifest("gui", {
        packageVersion: "0.1.0.0",
        appBuildNumber: 1,
        namespaceProfile: "approved" as never,
      }),
    ).toThrow();
  });
  it.each(["0.1.0.1", "0.1.1.0", "0.1.0", "0.1.0.65536"])(
    "rejects unapproved GUI submission version %s",
    (packageVersion) =>
      expect(() =>
        renderStoreManifest("gui", {
          packageVersion,
          appBuildNumber: 1,
          namespaceProfile: "packaged-classic-v1",
        }),
      ).toThrow(),
  );
  it("requires explicit build numbers and no hidden approval flag", () => {
    expect(() =>
      renderStoreManifest("gui", {
        packageVersion: "0.1.0.0",
        appBuildNumber: 0,
        namespaceProfile: "packaged-classic-v1",
      }),
    ).toThrow();
    let invoked = false;
    const options = {
      packageVersion: "0.1.0.0",
      appBuildNumber: 1,
      namespaceProfile: "packaged-classic-v1" as const,
    };
    Object.defineProperty(options, "namespaceProfile", {
      enumerable: true,
      get() {
        invoked = true;
        return "packaged-classic-v1";
      },
    });
    expect(() => renderStoreManifest("gui", options)).toThrow();
    expect(invoked).toBe(false);
    expect(() =>
      renderStoreManifest("gui", {
        packageVersion: "0.1.0.0",
        appBuildNumber: 1,
        namespaceProfile: "packaged-classic-v1",
        approved: true,
      } as never),
    ).toThrow();
  });
  it("configures only unsigned upload directory production with ASAR/fuses and actual artwork", () => {
    const config = storeElectronDirectoryConfig("C:\\MusicMuteStoreBuild\\gui");
    expect(config.win.target).toEqual([{ target: "dir", arch: ["x64"] }]);
    expect(config.publish).toBe(null);
    expect(config.asar).toBe(true);
    expect(config.disableAsarIntegrity).toBe(false);
    expect(config.electronFuses).toMatchObject({
      runAsNode: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
    });
    expect(config.win).toMatchObject({
      requestedExecutionLevel: "asInvoker",
      signExecutable: false,
      signAndEditExecutable: true,
    });
    expect(config.win.icon).toContain("app-icon.ico");
  });
  it.each([
    "C:\\",
    "C:\\build\\..\\stale",
    "C:\\build\\unsafe;stage",
    "C:\\build\\unsafe$stage",
    "\\\\server\\share\\stage",
  ])("rejects a nonexclusive or noncanonical directory %s", (stage) =>
    expect(() => storeElectronDirectoryConfig(stage)).toThrow(),
  );
});

describe("existing source artwork, no sample icons", () => {
  it("generates all Store dimensions and ICO from the exact current extension bitmap", async () => {
    const source = await readFile(resolve("..", STORE_ICON_SOURCE.path));
    expect(sha(source)).toBe(STORE_ICON_SOURCE.sha256);
    const assets = buildStoreAssets(source);
    expect(Object.keys(assets).sort()).toEqual(
      Object.keys(STORE_ASSET_DIMENSIONS).sort(),
    );
    for (const [name, bytes] of Object.entries(assets)) {
      const image = decodeStoreAssetPng(bytes);
      expect([image.width, image.height]).toEqual(
        STORE_ASSET_DIMENSIONS[name as keyof typeof STORE_ASSET_DIMENSIONS],
      );
      expect(image.rgba.some((value, i) => i % 4 === 3 && value > 0)).toBe(
        true,
      );
    }
    const wide = decodeStoreAssetPng(assets["Wide310x150Logo.png"]);
    expect(wide.rgba.subarray(0, 80 * 4).every((v) => v === 0)).toBe(true);
    const ico = buildStoreIcon(source);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(1);
    expect([ico[6], ico[7]]).toEqual([0, 0]);
    expect(ico.readUInt32LE(14)).toBe(ico.length - 22);
    expect(ico.readUInt32LE(18)).toBe(22);
    const icon = decodeStoreAssetPng(ico.subarray(22));
    expect([icon.width, icon.height]).toEqual([256, 256]);
    expect(icon.rgba.some((value, i) => i % 4 === 3 && value > 0)).toBe(true);
    expect(buildStoreIcon(source)).toEqual(ico);
    const root = await temporary(),
      target = join(root, "Assets");
    const rows = await stageStoreAssets(source, target);
    for (const row of rows)
      expect(sha(await readFile(join(target, row.path)))).toBe(row.sha256);
    await expect(stageStoreAssets(source, target)).rejects.toMatchObject({
      code: "EEXIST",
    });
  });
  it("rejects changed artwork, CRC damage and truncated PNG before staging", async () => {
    const source = await readFile(resolve("..", STORE_ICON_SOURCE.path)),
      changed = Buffer.from(source);
    changed[40] = changed[40]! ^ 1;
    expect(() => buildStoreAssets(changed)).toThrow();
    expect(() => decodeStoreAssetPng(changed)).toThrow();
    expect(() => decodeStoreAssetPng(source.subarray(0, 30))).toThrow();
  });
});

describe("closed cross-language code inventories", () => {
  it("accepts canonical ASCII binary sorting and safely parses a full census beyond ordinary IPC node limits", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({
      path: `worker/app/engine/musicmute_engine/module_${String(i).padStart(5, "0")}.py`,
      bytes: 1,
      sha256: "a".repeat(64),
    }));
    const parsed = parseStoreCodeInventoryBytes(
      Buffer.from(JSON.stringify(inventory(rows))),
    );
    expect(parsed.entries).toHaveLength(5000);
    expect(parsed.entries[4999]!.path).toContain("04999");
    expect(parseStoreCodeInventory(inventory()).role).toBe("worker");
  });
  it.each(
    [
      [
        {
          path: "worker/runtime/node/node.exe",
          bytes: 1,
          sha256: "a".repeat(64),
        },
        {
          path: "worker/runtime/Node/node.exe",
          bytes: 1,
          sha256: "a".repeat(64),
        },
      ],
      [
        {
          path: "worker/runtime/node/node.exe",
          bytes: 1,
          sha256: "a".repeat(64),
        },
        { path: "worker/agent/personal.cjs", bytes: 1, sha256: "a".repeat(64) },
      ],
      [{ path: "app/MusicMute Local.exe", bytes: 1, sha256: "a".repeat(64) }],
      [
        {
          path: "worker/runtime/python/../node/node.exe",
          bytes: 1,
          sha256: "a".repeat(64),
        },
      ],
      [
        {
          path: "worker/runtime/python/caf\u00e9.py",
          bytes: 1,
          sha256: "a".repeat(64),
        },
      ],
    ].map((entries) => ({ entries })),
  )(
    "rejects aliases, unsorted rows, foreign owners and unsafe paths",
    ({ entries }) =>
      expect(() => parseStoreCodeInventory(inventory(entries))).toThrow(),
  );
  it.each([
    "worker//node.exe",
    "worker/../node.exe",
    "worker/node.exe:stream",
    "worker/CON.exe",
    "worker/node.exe ",
    "worker/node\u0000.exe",
  ])("rejects unsafe path %j", (value) =>
    expect(() => safeStoreRelativePath(value)).toThrow(),
  );
  it("rejects decoded duplicate keys in the header and individual large-census rows", () => {
    const text = JSON.stringify(inventory());
    expect(() =>
      parseStoreCodeInventoryBytes(
        Buffer.from(
          text.replace('"role":"worker"', '"role":"gui","\\u0072ole":"worker"'),
        ),
      ),
    ).toThrow();
    expect(() =>
      parseStoreCodeInventoryBytes(
        Buffer.from(
          text.replace('"entries":[', '"entries":[],"\\u0065ntries":['),
        ),
      ),
    ).toThrow();
    expect(() =>
      parseStoreCodeInventoryBytes(
        Buffer.from(text.replace('"bytes":10', '"bytes":1,"bytes":10')),
      ),
    ).toThrow();
    expect(() =>
      parseStoreCodeInventoryBytes(Buffer.from(text.replace(/\]\}$/u, ",]}"))),
    ).toThrow();
    expect(() =>
      parseStoreCodeInventoryBytes(new Uint8Array(8 * 1024 ** 2 + 1)),
    ).toThrow();
  });
  it.each([
    "runtime/python/tests/a.py",
    "app/dist/a.js.map",
    "runtime/model.onnx",
    "app/node_modules/electron-builder/index.js",
    "runtime/python/.env",
    "runtime/python/a.db",
    "runtime/service/WinSW.exe",
    "runtime/runtime-metadata.json",
    "runtime/python/lib.so",
    "app/node_modules/.modules.yaml",
    "app/node_modules/.pnpm-workspace-state-v1.json",
  ])("rejects prohibited consumer content %s", (path) =>
    expect(() => assertStorePayloadPath("worker", path)).toThrow(),
  );
  it("binds all 43 fixed Python library resources to exact inventory bytes and hashes", () => {
    const resources = [
      {
        path: "runtime/python/Lib/site-packages/pip/_vendor/urllib3/contrib/emscripten/emscripten_fetch_worker.js",
        bytes: 3677,
        sha256:
          "cf5937cd9e3f84329ddfeb4def0cf3f0b1e31c2da9c4dfeebbc07793d0fd0377",
      },
      {
        path: "runtime/python/Lib/site-packages/sklearn/utils/_repr_html/estimator.js",
        bytes: 6286,
        sha256:
          "bb51d66dec886f0694d382fd378d960f7842245ccdfa373ecd647ea2b11cfd93",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/__init__.py",
        bytes: 1344,
        sha256:
          "1f5f3f7d9667a94007cbf5b1b1bc4a60d24fc7285de5754a0ff1917ca80038ff",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/assume_constant_result.py",
        bytes: 626,
        sha256:
          "ea168b7015841cb6e222553c418108ec6a7d139da3b2dc8f745010cb8e449801",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/autograd_function.py",
        bytes: 647,
        sha256:
          "aae4bfe5f608c3183986a1326d55c31b48648631e86923abca2492f299152601",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/class_method.py",
        bytes: 562,
        sha256:
          "123401857db1a0e7c8ba2715542f75fb8559307284669002bb2fb24a8f24fc77",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/cond_branch_class_method.py",
        bytes: 1417,
        sha256:
          "e1c41b86ac558c2ff2a95e256cb811e6b31a7692d81eaba3b0bc5327ba3c0bfd",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/cond_branch_nested_function.py",
        bytes: 1445,
        sha256:
          "2b31fb0fc1a1633775ffb582da7578e729e57ebcf9a478902a27765087cd912b",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/cond_branch_nonlocal_variables.py",
        bytes: 2001,
        sha256:
          "b7cda918c2b7bca28834ca8904977678367e99b6f02e29cec2014c2a840bb66c",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/cond_closed_over_variable.py",
        bytes: 608,
        sha256:
          "23843d43cea897b8432e1baf9e592a90157d19f5996897b99cb84f796e7c0a80",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/cond_operands.py",
        bytes: 1002,
        sha256:
          "ea99267422becf2413182cc79ad4d7d96592bb51bda31e25771c7cb3efce92b4",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/cond_predicate.py",
        bytes: 803,
        sha256:
          "75f0a794d2f97028a314b596e449329230d5e0b0ad6a5be7dc2fa9de77239f99",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/constrain_as_size_example.py",
        bytes: 766,
        sha256:
          "78c67d9f652bcee02a83d147ff8e58c454ecff378c0bfcaa00d56630b96b5404",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/constrain_as_value_example.py",
        bytes: 820,
        sha256:
          "46d2a91279151901fec126516670b0581670938143783983802c8191c92332ac",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/decorator.py",
        bytes: 556,
        sha256:
          "ca699a762873b02fc30c7ed9396f13d57c0a86af03977aec7669903b2701b4f7",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/dictionary.py",
        bytes: 527,
        sha256:
          "aa28ead13945660e96f8b7534a687619605a93fc93a56beaef67cfa61434c6af",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/dynamic_shape_assert.py",
        bytes: 566,
        sha256:
          "9216138c200b229f517a151d3d0c7f6bfe024ebd242be5ff0a8f4e639ba5c4ac",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/dynamic_shape_constructor.py",
        bytes: 504,
        sha256:
          "4aa008a501bb9fc552091ad6ecfdfdac4e2582473ff7446f879542e8cd286aa2",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/dynamic_shape_if_guard.py",
        bytes: 623,
        sha256:
          "5e752dac10dd3a86fbaad3cb200670b2d1907726c94ee88d9582e08f9515b69b",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/dynamic_shape_map.py",
        bytes: 574,
        sha256:
          "d99f90d5a691d88c43c2bda3b6717213904c2b4b0a4ed1d76195e098fe5cdc36",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/dynamic_shape_round.py",
        bytes: 617,
        sha256:
          "dd35ef47d7e02397209f520e87f9046708f23937ff933d12cece2c0dc3043fab",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/dynamic_shape_slicing.py",
        bytes: 502,
        sha256:
          "d164fae22dfad4ba27972279b4ca78f5885b0538010703d8810094d41b9f692a",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/dynamic_shape_view.py",
        bytes: 563,
        sha256:
          "f02affff8e39358fb8acba44dbe0b05b3415a4daa36aae7357c27572792e5974",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/fn_with_kwargs.py",
        bytes: 931,
        sha256:
          "8938cf59b322335ab254eb7e1d7bd13fac447dc6d0c065018f672cf919af255c",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/list_contains.py",
        bytes: 598,
        sha256:
          "7b8df086fffc7635626cebcf8cf38f549c2b585d0893d4d8a73be440d6a0232d",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/list_unpack.py",
        bytes: 722,
        sha256:
          "9017bda33b434d3a91839c36dee502d8ca5439cccc2005d102e0b343fcefd69f",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/model_attr_mutation.py",
        bytes: 691,
        sha256:
          "e45b9243dc985e538791580404c1837344b4e80a740bbcb461e57dba4d9bfbae",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/nested_function.py",
        bytes: 616,
        sha256:
          "cf8e16e37e4cd070a6eaee01ff5345406d4584ce9b834a213949cfdd518406b0",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/null_context_manager.py",
        bytes: 599,
        sha256:
          "7a6097af6c2d6f0e2fa669613bb49e2dc63bb447463e5a62d11169ee7d3ec35a",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/optional_input.py",
        bytes: 490,
        sha256:
          "5bf8a4a4d78f69b3e511678dc8fd88f75152274f440c8058eb278bea5d38e5d4",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/pytree_flatten.py",
        bytes: 545,
        sha256:
          "940c0d1ec6122d0f05753e75540d277407054e7f560b4e8e6a44386c47b42357",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/scalar_output.py",
        bytes: 608,
        sha256:
          "e2b21fa257f5c02688bc12d94b47699131c9e76b54f4cc5bc0d7befe0d2639e5",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/specialized_attribute.py",
        bytes: 580,
        sha256:
          "f62396b5dbfacbef0e4baeeea29f8c791f2d69a15e5917ee3ef98f0ca829d95f",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/static_for_loop.py",
        bytes: 534,
        sha256:
          "54aab8f375f59de2179ca181098c7b30a7945a4f57b18a1b23843e1e76c940c9",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/static_if.py",
        bytes: 525,
        sha256:
          "b80bafc19d9ee7dea40651d1905a9800edbc38ec2a356506b6bea1bfbca20c1b",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/tensor_setattr.py",
        bytes: 457,
        sha256:
          "8ca0e4155692e2955398eec99b0dad1e3f990172ffafee01ee71a266f862d313",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/torch_sym_min.py",
        bytes: 446,
        sha256:
          "21a2d223aa1426455e6cb8df086dc79ac45d415cd154e501b61e554ead59d067",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/type_reflection_method.py",
        bytes: 945,
        sha256:
          "1464e33e7469d2a29a12b3b55c6fb35faa5bca147fa362aeeee53c7b92a82715",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/user_input_mutation.py",
        bytes: 418,
        sha256:
          "c8b63a47f89015243d5ca923286485be9341a198d5f26d50767bde3fe8c3b2e9",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/utils/model_dump/code.js",
        bytes: 19940,
        sha256:
          "b1c9c5fad55aacd09387de8cd5732480bb71396d478632c3990b9ea414f5ca04",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/utils/model_dump/htm.mjs",
        bytes: 1232,
        sha256:
          "24e71b6de558d9929ba05beb0e496a03ad5f9b780e5146c62291aeaf276c86a3",
      },
      {
        path: "runtime/python/Lib/site-packages/torch/utils/model_dump/preact.mjs",
        bytes: 10080,
        sha256:
          "1426fd5ee34aa5c12919fa36564fb45eb7a6fe612310cb801dae3c56227c479c",
      },
      {
        path: "runtime/python/Lib/site-packages/urllib3/contrib/emscripten/emscripten_fetch_worker.js",
        bytes: 3677,
        sha256:
          "cf5937cd9e3f84329ddfeb4def0cf3f0b1e31c2da9c4dfeebbc07793d0fd0377",
      },
    ];
    const rows = resources.map((entry) => ({
      ...entry,
      path: `worker/${entry.path}`,
    }));
    expect(parseStoreCodeInventory(inventory(rows)).entries).toEqual(rows);
    expect(
      parseStoreCodeInventoryBytes(Buffer.from(JSON.stringify(inventory(rows))))
        .entries,
    ).toEqual(rows);
    for (const [index, entry] of resources.entries()) {
      expect(assertStorePayloadPath("worker", entry.path)).toBe(entry.path);
      if (/\.(?:js|mjs)$/u.test(entry.path))
        expect(() => classifyStoreCode("worker", entry.path)).toThrow(
          "STORE_CONTRACT_INVALID",
        );
      for (const changed of [
        { ...rows[index]!, bytes: entry.bytes + 1 },
        { ...rows[index]!, sha256: "b".repeat(64) },
      ]) {
        const altered = [...rows];
        altered[index] = changed;
        expect(() => parseStoreCodeInventory(inventory(altered))).toThrow(
          "STORE_INVENTORY_INVALID",
        );
      }
    }
  });
  it.each([
    "runtime/python/Lib/site-packages/torch/_export/db/examples/foreign.py",
    "runtime/python/Lib/site-packages/torch/_export/db/examples/nested/user_input_mutation.py",
    "runtime/python/Lib/site-packages/torch/_export/db/examples/User_input_mutation.py",
    "runtime/python/Lib/site-packages/torch/utils/model_dump/foreign.mjs",
    "runtime/python/Lib/site-packages/torch/utils/model_dump/htm.MJS",
    "runtime/python/Lib/site-packages/sklearn/utils/_repr_html/estimator.js.extra.js",
    "runtime/python/Lib/site-packages/ml_collections/config_dict/examples/config.py",
    "app/node_modules/gensync/test/index.test.js",
  ])("keeps unapproved resource lookalike %s outside the payload", (path) => {
    expect(() => assertStorePayloadPath("worker", path)).toThrow();
  });
  it("hashes genuine pinned Python/module resource bytes and rejects same-size mutations", async () => {
    // Public PyTorch 2.4.1 BSD-licensed sources. Python text uses the exact
    // Windows wheel CRLF bytes; neither resource is executed by this fixture.
    const fixtures = [
      {
        path: "runtime/python/Lib/site-packages/torch/_export/db/examples/user_input_mutation.py",
        data: Buffer.from(
          '# mypy: allow-untyped-defs\r\nimport torch\r\n\r\nfrom torch._export.db.case import export_case, SupportLevel\r\n\r\n\r\n@export_case(\r\n    example_inputs=(torch.randn(3, 2),),\r\n    tags={"torch.mutation"},\r\n    support_level=SupportLevel.SUPPORTED,\r\n)\r\nclass UserInputMutation(torch.nn.Module):\r\n    """\r\n    Directly mutate user input in forward\r\n    """\r\n\r\n    def forward(self, x):\r\n        x.mul_(2)\r\n        return x.cos()\r\n',
        ),
      },
      {
        path: "runtime/python/Lib/site-packages/torch/utils/model_dump/htm.mjs",
        data: Buffer.from(
          '// HTM, Apache License\r\nvar n=function(t,s,r,e){var u;s[0]=0;for(var h=1;h<s.length;h++){var p=s[h++],a=s[h]?(s[0]|=p?1:2,r[s[h++]]):s[++h];3===p?e[0]=a:4===p?e[1]=Object.assign(e[1]||{},a):5===p?(e[1]=e[1]||{})[s[++h]]=a:6===p?e[1][s[++h]]+=a+"":p?(u=t.apply(a,n(t,a,r,["",null])),e.push(u),a[0]?s[0]|=2:(s[h-2]=0,s[h]=u)):e.push(a)}return e},t=new Map;export default function(s){var r=t.get(this);return r||(r=new Map,t.set(this,r)),(r=n(this,r.get(s)||(r.set(s,r=function(n){for(var t,s,r=1,e="",u="",h=[0],p=function(n){1===r&&(n||(e=e.replace(/^\\s*\\n\\s*|\\s*\\n\\s*$/g,"")))?h.push(0,n,e):3===r&&(n||e)?(h.push(3,n,e),r=2):2===r&&"..."===e&&n?h.push(4,n,0):2===r&&e&&!n?h.push(5,0,!0,e):r>=5&&((e||!n&&5===r)&&(h.push(r,0,e,s),r=6),n&&(h.push(r,n,0,s),r=6)),e=""},a=0;a<n.length;a++){a&&(1===r&&p(),p(a));for(var l=0;l<n[a].length;l++)t=n[a][l],1===r?"<"===t?(p(),h=[h],r=3):e+=t:4===r?"--"===e&&">"===t?(r=1,e=""):e=t+e[0]:u?t===u?u="":e+=t:\'"\'===t||"\'"===t?u=t:">"===t?(p(),r=1):r&&("="===t?(r=5,s=e,e=""):"/"===t&&(r<5||">"===n[a][l+1])?(p(),3===r&&(h=h[0]),r=h,(h=h[0]).push(2,0,r),r=0):" "===t||"\\t"===t||"\\n"===t||"\\r"===t?(p(),r=2):e+=t),3===r&&"!--"===e&&(r=4,h=h[0])}return p(),h}(s)),r),arguments,[])).length>1?r:r[0]}\r\n',
        ),
      },
    ];
    for (const resource of fixtures) {
      const root = await temporary(),
        file = join(root, resource.path);
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, resource.data);
      const expected = {
        path: resource.path,
        bytes: resource.data.length,
        sha256: sha(resource.data),
      };
      expect(await listStorePayload(root, "worker")).toEqual([expected]);
      expect(
        (await createStoreCodeInventory(root, "worker", "0.1.3.0", 1)).entries,
      ).toEqual([{ ...expected, path: `worker/${resource.path}` }]);
      const changed = Buffer.from(resource.data);
      changed[0] = changed[0]! ^ 1;
      await writeFile(file, changed);
      await expect(listStorePayload(root, "worker")).rejects.toThrow(
        "STORE_INVENTORY_INVALID",
      );
      await writeFile(file, resource.data);
      await link(file, join(file, "..", "alias"));
      await expect(listStorePayload(root, "worker")).rejects.toThrow();
    }
  });
  it("walks and hashes actual new files while rejecting symlinks and hardlinks", async () => {
    const root = await temporary();
    await mkdir(join(root, "runtime/node"), { recursive: true });
    await writeFile(join(root, "runtime/node/node.exe"), "node-byte-fixture");
    const rows = await listStorePayload(root, "worker");
    expect(rows[0]).toMatchObject({
      path: "runtime/node/node.exe",
      bytes: 17,
      sha256: sha(Buffer.from("node-byte-fixture")),
    });
    const protectedIndex = await createStoreCodeInventory(
      root,
      "worker",
      "0.1.3.0",
      1,
    );
    expect(protectedIndex.entries[0]!.path).toBe(
      "worker/runtime/node/node.exe",
    );
    await symlink(
      join(root, "runtime/node/node.exe"),
      join(root, "runtime/node/link.exe"),
    );
    await expect(listStorePayload(root, "worker")).rejects.toThrow();
    const separate = await temporary(),
      a = join(separate, "one"),
      b = join(separate, "two");
    await writeFile(a, "data");
    await link(a, b);
    await expect(hashStoreFile(a)).rejects.toThrow();
  });
  it("retains legitimate empty Python modules with their exact empty digest and unchanged link guards", async () => {
    const root = await temporary();
    const path = "runtime/python/Lib/site-packages/audio_separator/__init__.py";
    await mkdir(
      join(root, "runtime/python/Lib/site-packages/audio_separator"),
      { recursive: true },
    );
    await writeFile(join(root, path), "");
    const expected = { path, bytes: 0, sha256: sha(Buffer.alloc(0)) };
    expect(await listStorePayload(root, "worker")).toEqual([expected]);
    await expect(
      auditStorePayloadEntry(root, "worker", expected),
    ).resolves.toBeUndefined();
    const result = await createStoreCodeInventory(root, "worker", "0.1.3.0", 1);
    expect(result.entries).toEqual([{ ...expected, path: `worker/${path}` }]);
    expect(
      parseStoreCodeInventoryBytes(Buffer.from(JSON.stringify(result))),
    ).toEqual(result);
    expect(() =>
      parseStoreCodeInventory({
        ...result,
        entries: [{ ...result.entries[0], sha256: "a".repeat(64) }],
      }),
    ).toThrow();
    expect(() =>
      parseStoreCodeInventory({
        ...result,
        entries: [{ ...result.entries[0], bytes: -1 }],
      }),
    ).toThrow();
    await link(
      join(root, path),
      join(root, "runtime/python/Lib/site-packages/audio_separator/alias.py"),
    );
    await expect(listStorePayload(root, "worker")).rejects.toThrow();
    await expect(
      auditStorePayloadEntry(root, "worker", expected),
    ).rejects.toThrow();
  });
  it.each(["content", "digest"] as const)(
    "rejects an admitted empty text file after its %s changes",
    async (change) => {
      const root = await temporary(),
        path = "runtime/python/__init__.py";
      await mkdir(join(root, "runtime/python"), { recursive: true });
      await writeFile(join(root, path), "");
      const [row] = await listStorePayload(root, "worker");
      if (change === "content") await writeFile(join(root, path), "changed");
      await expect(
        auditStorePayloadEntry(root, "worker", {
          ...row!,
          ...(change === "digest" ? { sha256: "a".repeat(64) } : {}),
        }),
      ).rejects.toThrow("STORE_PAYLOAD_INVALID");
    },
  );
  it.each(["missing", "symlink", "hardlink"] as const)(
    "rejects an admitted empty text file that becomes %s",
    async (change) => {
      const root = await temporary(),
        path = "runtime/python/__init__.py",
        file = join(root, path),
        other = join(root, "runtime/python/other.py");
      await mkdir(join(root, "runtime/python"), { recursive: true });
      await writeFile(file, "");
      const [row] = await listStorePayload(root, "worker");
      if (change === "hardlink") await link(file, other);
      else {
        await rm(file);
        if (change === "symlink") {
          await writeFile(other, "");
          await symlink(other, file);
        }
      }
      await expect(
        auditStorePayloadEntry(root, "worker", row!),
      ).rejects.toThrow();
    },
  );
  it.each(["unknown.py", "runtime/python/private/__init__.py"])(
    "does not admit an unknown or forbidden empty code path %s",
    async (path) => {
      const root = await temporary();
      await expect(
        auditStorePayloadEntry(root, "worker", {
          path,
          bytes: 0,
          sha256: sha(Buffer.alloc(0)),
        }),
      ).rejects.toThrow();
    },
  );
  it("keeps empty native binaries on the PE validation route", async () => {
    const root = await temporary(),
      path = "runtime/node/node.exe";
    await mkdir(join(root, "runtime/node"), { recursive: true });
    await writeFile(join(root, path), "");
    await expect(
      auditStorePayloadEntry(root, "worker", {
        path,
        bytes: 0,
        sha256: sha(Buffer.alloc(0)),
      }),
    ).rejects.toThrow();
  });
  it.each([
    '{"client_secret":"synthetic-fixture"}',
    "-----BEGIN PRIVATE KEY-----\n" + "A".repeat(16),
    "AKIA" + "A".repeat(16),
    '"AKIA' + "A".repeat(16) + '"',
    "access_key_id = 'AKIA" + "A".repeat(16) + "'",
    "(AKIA" + "A".repeat(16) + ");",
  ])("still scans nonempty text for secret pattern %#", async (text) => {
    const root = await temporary(),
      path = "runtime/python/config.py";
    await mkdir(join(root, "runtime/python"), { recursive: true });
    await writeFile(join(root, path), text);
    const [row] = await listStorePayload(root, "worker");
    await expect(auditStorePayloadEntry(root, "worker", row!)).rejects.toThrow(
      "STORE_PAYLOAD_INVALID",
    );
  });
  it.each([
    ["a".repeat(1024), "A".repeat(1024)],
    ["a", ""],
    ["", "A"],
  ])(
    "does not mistake a substring of longer base64 data for an AWS ID %#",
    async (before, after) => {
      const root = await temporary(),
        path = "runtime/python/font_data.py",
        text = 'FONT = "' + before + "AKIA" + "A".repeat(16) + after + '"';
      await mkdir(join(root, "runtime/python"), { recursive: true });
      await writeFile(join(root, path), text);
      const [row] = await listStorePayload(root, "worker");
      await expect(
        auditStorePayloadEntry(root, "worker", row!),
      ).resolves.toBeUndefined();
    },
  );
  it("retains the nonempty text reader's size limit", async () => {
    const root = await temporary(),
      path = "runtime/python/config.py";
    await mkdir(join(root, "runtime/python"), { recursive: true });
    const bytes = Buffer.alloc(8 * 1024 ** 2 + 1, 65);
    await writeFile(join(root, path), bytes);
    await expect(
      auditStorePayloadEntry(root, "worker", {
        path,
        bytes: bytes.length,
        sha256: sha(bytes),
      }),
    ).rejects.toThrow("PACKAGE_INPUT_INVALID");
  });
});

describe("Store Worker release manifests without empty directories", () => {
  async function fixture() {
    const stage = await temporary(),
      root = join(stage, "worker"),
      backup = join(stage, "release-before-msix.json");
    const paths = [
      ...STORE_WORKER_REQUIRED_FILES.filter(
        (path) => path !== "release-manifest.json",
      ),
      "app/engine/musicmute_engine/windows_gpu.py",
      "app/engine/musicmute_engine/provider_adapter.py",
      "app/engine/musicmute_engine/qualification.py",
      "app/retained.txt",
    ];
    for (const path of paths) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), `${path}\n`);
    }
    await mkdir(join(root, "unused/empty"), { recursive: true });
    const original = await writeWindowsReleaseManifest(
        root,
        "0.1.3",
        "windows-user",
      ),
      originalBytes = await readFile(join(root, "release-manifest.json"));
    await rm(join(root, "unused"), { recursive: true });
    return { root, backup, original, originalBytes };
  }
  it("preserves original metadata and all files, removes only missing fileless directories, and passes strict verification", async () => {
    const f = await fixture();
    await expect(verifyWindowsRelease(f.root, "windows-user")).rejects.toThrow(
      "does not match",
    );
    const result = await normalizeStoreWorkerReleaseManifest(f.root, f.backup),
      actual = await verifyWindowsRelease(f.root, "windows-user");
    expect(result.removedDirectories).toEqual(["unused", "unused/empty"]);
    expect(result.releaseVersion).toBe("0.1.3");
    expect(result.installationProfile).toBe("windows-user");
    expect(await readFile(f.backup)).toEqual(f.originalBytes);
    expect(actual.entries).toEqual(
      f.original.entries.filter(
        (entry) => !result.removedDirectories.includes(entry.path),
      ),
    );
    expect(result.filesUnchanged).toBe(
      actual.entries.filter((entry) => entry.kind === "file").length,
    );
  });
  it.each([
    "changed",
    "missing",
    "extra",
    "kind",
    "symlink",
    "empty directory",
  ] as const)(
    "denies a %s entry before preserving or replacing any manifest",
    async (change) => {
      const f = await fixture(),
        file = join(f.root, "app/retained.txt");
      if (change === "changed") {
        const bytes = await readFile(file);
        bytes[0] = bytes[0]! ^ 1;
        await writeFile(file, bytes);
      } else if (change === "extra")
        await writeFile(join(f.root, "app/extra.txt"), "extra");
      else if (change === "empty directory")
        await mkdir(join(f.root, "extra-empty"));
      else {
        await rm(file);
        if (change === "kind") await mkdir(file);
        if (change === "symlink")
          await symlink(join(f.root, "app/package.json"), file);
      }
      await expect(
        normalizeStoreWorkerReleaseManifest(f.root, f.backup),
      ).rejects.toThrow();
      expect(await readFile(join(f.root, "release-manifest.json"))).toEqual(
        f.originalBytes,
      );
      await expect(readFile(f.backup)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
  it("refuses an inside-payload backup or an existing backup without replacing metadata", async () => {
    const f = await fixture();
    await expect(
      normalizeStoreWorkerReleaseManifest(f.root, join(f.root, "old.json")),
    ).rejects.toThrow();
    await writeFile(f.backup, "preserved");
    await expect(
      normalizeStoreWorkerReleaseManifest(f.root, f.backup),
    ).rejects.toThrow();
    expect(await readFile(f.backup, "utf8")).toBe("preserved");
    expect(await readFile(join(f.root, "release-manifest.json"))).toEqual(
      f.originalBytes,
    );
  });
});

describe("complete runtime and upload-only build receiving gates", () => {
  it("binds the GUI resource-seal/outer application build to exact desktop build metadata", () => {
    const bytes = Buffer.from(
      '{"version":1,"appVersion":"0.1.0","buildNumber":1}',
    );
    expect(parseStoreGuiBuildMetadata(bytes, 1)).toEqual({
      version: 1,
      appVersion: "0.1.0",
      buildNumber: 1,
    });
    expect(() => parseStoreGuiBuildMetadata(bytes, 2)).toThrow();
    expect(() =>
      parseStoreGuiBuildMetadata(
        Buffer.from(
          '{"version":1,"appVersion":"0.1.0","buildNumber":0,"buildNumber":1}',
        ),
        1,
      ),
    ).toThrow();
    expect(() =>
      parseStoreGuiBuildMetadata(
        Buffer.from(
          '{"version":1,"appVersion":"0.1.0","buildNumber":1,"approved":true}',
        ),
        1,
      ),
    ).toThrow();
  });
  it("checks the complete current Worker compiler output census, rejecting stale or missing module bytes", async () => {
    const root = await temporary(),
      workerRoot = join(root, "source"),
      payload = join(root, "payload");
    await mkdir(join(workerRoot, "dist/src/cli"), { recursive: true });
    await mkdir(join(payload, "app/dist/src/cli"), { recursive: true });
    for (const path of [
      join(workerRoot, "dist/src/cli/main.js"),
      join(payload, "app/dist/src/cli/main.js"),
    ])
      await writeFile(path, "export const current = 1;");
    await writeFile(join(workerRoot, "dist/src/cli/main.js.map"), "build-only");
    await expect(
      auditStoreWorkerCompiledOutputs(payload, workerRoot),
    ).resolves.toEqual(["app/dist/src/cli/main.js"]);
    await writeFile(
      join(payload, "app/dist/src/cli/main.js"),
      "export const current = 0;",
    );
    await expect(
      auditStoreWorkerCompiledOutputs(payload, workerRoot),
    ).rejects.toThrow();
    await writeFile(
      join(payload, "app/dist/src/cli/main.js"),
      "export const current = 1;",
    );
    await writeFile(
      join(workerRoot, "dist/src/cli/required.js"),
      "export const required = true;",
    );
    await expect(
      auditStoreWorkerCompiledOutputs(payload, workerRoot),
    ).rejects.toThrow();
  });
  it("rebuilds and checks the real shared extension with notices, rejecting modified or extra files", async () => {
    const root = await temporary(),
      folder = join(root, "extension");
    await mkdir(folder);
    const { stageSharedExtension } = await import(
      pathToFileURL(resolve("packaging/shared-extension.mjs")).href
    );
    await stageSharedExtension(folder, async (path: string) => readFile(path));
    await expect(
      auditStoreSharedExtension(folder, process.cwd()),
    ).resolves.toMatchObject({
      extensionId: "acmgefmmndomcpdlgnafkjbgobinllep",
    });
    const path = join(folder, "content.js"),
      original = await readFile(path);
    await writeFile(
      path,
      Buffer.concat([original, Buffer.from("\n// stale changed bytes\n")]),
    );
    await expect(
      auditStoreSharedExtension(folder, process.cwd()),
    ).rejects.toThrow();
    await writeFile(path, original);
    await writeFile(join(folder, "extra.js"), "foreign");
    await expect(
      auditStoreSharedExtension(folder, process.cwd()),
    ).rejects.toThrow();
  });
  it("reads each actual compiler graph with unique-key bounds without expanding ordinary IPC limits", async () => {
    const bytes = await readFile("dist/build-metafiles.json");
    expect(parseStoreBuildGraphs(bytes)).toHaveLength(12);
    const bad = JSON.stringify(
      Array.from({ length: 12 }, () => ({ entry: "fixed" })),
    ).replace('"entry":"fixed"', '"entry":"foreign","entry":"fixed"');
    expect(() => parseStoreBuildGraphs(Buffer.from(bad))).toThrow();
    expect(() => parseStoreBuildGraphs(Buffer.from("[{}]"))).toThrow();
  });
  it("receives a full Worker DLL import manifest above ordinary IPC's node cap", () => {
    const source = {
      schemaVersion: 1,
      installationProfile: "windows-user",
      requirementsLockSha256: "a".repeat(64),
      pins: { node: "24.18.0", python: "3.11.11" },
      observed: { nativeArchitecture: "x64", packages: {} },
      dllAudit: {
        policy: "private-pe-imports-msvc-v3",
        imports: Array.from({ length: 6000 }, (_, index) => ({
          binary: `runtime/python/Lib/site-packages/module${index}/native.pyd`,
          name: "kernel32.dll",
          kind: "import",
          source: "windows",
        })),
      },
    };
    const text = JSON.stringify(source);
    expect(() => parseStrictJson(text, 8 * 1024 ** 2, 16384)).toThrow(
      "INVALID_JSON",
    );
    expect(parseStoreWorkerSourceManifest(Buffer.from(text))).toEqual(source);
  });
  it("keeps Worker manifest byte, node, depth and decoded-key bounds", () => {
    const malformed = [
      Buffer.from('{"schemaVersion":1,"schema\\u0056ersion":1}'),
      Buffer.from('{"dllAudit":{"imports":[null,]}}'),
      Buffer.from('{"value":1e999}'),
      Buffer.from("[".repeat(33) + "0" + "]".repeat(33)),
      Buffer.from(JSON.stringify(Array.from({ length: 400000 }, () => null))),
      Buffer.alloc(8 * 1024 ** 2 + 1, 0x20),
      Buffer.from([0xc3, 0x28]),
    ];
    for (const bytes of malformed)
      expect(() => parseStoreWorkerSourceManifest(bytes)).toThrow();
  });
  it("reports complete immutable runtime requirements for an empty/source-only worker", async () => {
    const root = await temporary();
    await mkdir(join(root, "app/engine"), { recursive: true });
    try {
      await requireStorePayloadFiles(root, "worker");
      throw new Error("unexpected pass");
    } catch (error) {
      expect(error).toBeInstanceOf(StoreInputsMissing);
      expect((error as StoreInputsMissing).missing).toEqual(
        STORE_WORKER_REQUIRED_FILES,
      );
      expect((error as StoreInputsMissing).missing).toContain(
        "runtime/python/python.exe",
      );
      expect((error as StoreInputsMissing).missing).toContain(
        "tools/youtube/bin/deno.exe",
      );
      expect((error as StoreInputsMissing).missing).toContain(
        "app/engine/musicmute_engine/store_consumer_personal.py",
      );
      expect((error as StoreInputsMissing).missing).toContain(
        "app/engine/musicmute_engine/store_qualification.py",
      );
    }
  });
  it("requires the immutable Chrome manifest in the GUI payload", async () => {
    const root = await temporary();
    for (const key of STORE_GUI_REQUIRED_FILES) {
      if (key === "resources/native/com.musicmute.local.json") continue;
      const file = join(root, key);
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, "fixture");
    }
    await expect(requireStorePayloadFiles(root, "gui")).rejects.toMatchObject({
      missing: ["resources/native/com.musicmute.local.json"],
    });
  });
  it.each([
    "app/dist/src/runtime/store-transfer-process.js",
    "app/engine/musicmute_engine/store_benchmark_file.py",
    "app/engine/musicmute_engine/store_benchmark_capacity.py",
    "app/engine/musicmute_engine/store_benchmark_context.py",
  ])(
    "requires actual protected new Worker leaf %s, independent of sibling leaves",
    async (missing) => {
      // File-presence receiving fixture only, not an executable/runtime candidate.
      const root = await temporary();
      for (const key of STORE_WORKER_REQUIRED_FILES) {
        if (key === missing) continue;
        const path = join(root, ...key.split("/"));
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, "synthetic-file-presence-only");
      }
      if (missing === "app/dist/src/runtime/store-transfer-process.js") {
        const wrong = join(root, "app/src/runtime/store-transfer-process.js");
        await mkdir(join(wrong, ".."), { recursive: true });
        await writeFile(wrong, "unproduced-route-cannot-substitute");
      }
      await expect(
        requireStorePayloadFiles(root, "worker"),
      ).rejects.toMatchObject({ missing: [missing] });
    },
  );
  it("binds the full fixed transfer ESM import closure under the genuine app/dist layout", async () => {
    const root = await temporary(),
      source = join(root, "source"),
      payload = join(root, "payload");
    const files = [
      "src/runtime/store-transfer-process.js",
      "src/runtime/store-transfer-contracts.js",
      "src/runtime/transfers.js",
      "src/runtime/workspace.js",
      "src/runtime/transfer-workspace-owner.js",
      "src/platform/windows/consumer-strict-json.js",
    ];
    for (const key of files) {
      for (const base of [join(source, "dist"), join(payload, "app/dist")]) {
        const path = join(base, ...key.split("/"));
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(
          path,
          `export const receivingOnly = ${JSON.stringify(key)};`,
        );
      }
    }
    expect(await auditStoreWorkerCompiledOutputs(payload, source)).toEqual(
      files.map((key) => `app/dist/${key}`).sort(),
    );
    await writeFile(
      join(payload, "app/dist/src/runtime/workspace.js"),
      "export const staleMime = true;",
    );
    await expect(
      auditStoreWorkerCompiledOutputs(payload, source),
    ).rejects.toThrow();
  });
  it("accepts only the protected Chrome host and exact shared-extension origin", async () => {
    const manifest = {
      name: "com.musicmute.local",
      description: "MusicMute Windows companion",
      path: "../../MusicMuteChromeHost.exe",
      type: "stdio",
      allowed_origins: ["chrome-extension://acmgefmmndomcpdlgnafkjbgobinllep/"],
    };
    const bytes = Buffer.from(JSON.stringify(manifest));
    expect(parseStoreNativeMessagingManifest(bytes)).toEqual(manifest);
    const { SHARED_EXTENSION_ID } = await import(
      pathToFileURL(resolve("packaging/shared-extension.mjs")).href
    );
    expect(manifest.allowed_origins).toEqual([
      `chrome-extension://${SHARED_EXTENSION_ID}/`,
    ]);
    for (const patch of [
      { name: "com.foreign.local" },
      { description: "foreign" },
      { path: "../../MusicMute Local.exe" },
      { path: "C:\\mutable\\MusicMuteChromeHost.exe" },
      { path: "../../../MusicMuteChromeHost.exe" },
      { type: "socket" },
      { allowed_origins: [] },
      { allowed_origins: ["chrome-extension://*/"] },
      {
        allowed_origins: [
          ...manifest.allowed_origins,
          ...manifest.allowed_origins,
        ],
      },
      { allowed_origins: ["chrome-extension://foreign/"] },
      { extra: true },
    ])
      expect(() =>
        parseStoreNativeMessagingManifest(
          Buffer.from(JSON.stringify({ ...manifest, ...patch })),
        ),
      ).toThrow();
    const { path: _path, ...missing } = manifest;
    expect(() =>
      parseStoreNativeMessagingManifest(Buffer.from(JSON.stringify(missing))),
    ).toThrow();
    expect(() =>
      parseStoreNativeMessagingManifest(
        Buffer.from(
          bytes.toString().replace('"name":', '"name":"foreign","name":'),
        ),
      ),
    ).toThrow();
    expect(() =>
      parseStoreNativeMessagingManifest(Buffer.from([0xff])),
    ).toThrow();
    expect(() =>
      parseStoreNativeMessagingManifest(Buffer.alloc(16385, 32)),
    ).toThrow();
  });
  it("requires explicit unsigned-candidate purpose/builds/profile and rejects extra authority", () => {
    const inputs = {
      version: 1,
      purpose: "unsigned-store-upload-candidate",
      guiPayloadRoot: resolve("one"),
      workerPayloadRoot: resolve("two"),
      guiBuildNumber: 1,
      workerBuildNumber: 1,
      namespaceProfile: "packaged-classic-v1",
    };
    expect(
      parseStoreBuildInputsBytes(Buffer.from(JSON.stringify(inputs))),
    ).toEqual(inputs);
    expect(() => parseStoreBuildInputs({ ...inputs, publish: true })).toThrow();
    expect(() =>
      parseStoreBuildInputs({ ...inputs, guiBuildNumber: 0 }),
    ).toThrow();
    expect(() =>
      parseStoreBuildInputs({ ...inputs, purpose: "install" }),
    ).toThrow();
    let invoked = false;
    const getter = { ...inputs };
    Object.defineProperty(getter, "purpose", {
      enumerable: true,
      get() {
        invoked = true;
        return inputs.purpose;
      },
    });
    expect(() => parseStoreBuildInputs(getter)).toThrow();
    expect(invoked).toBe(false);
    expect(() =>
      parseStoreBuildInputs(
        Object.assign(Object.create({ authority: true }), inputs),
      ),
    ).toThrow();
    expect(() =>
      parseStoreBuildInputs({ ...inputs, [Symbol("extra")]: true }),
    ).toThrow();
  });
  it("fails outside native Windows before creating any candidate or executing tools", async () => {
    if (process.platform === "win32") return;
    const root = await temporary(),
      stage = join(root, "candidate");
    await expect(prepareStorePackages({}, root, stage)).rejects.toThrow(
      "WINDOWS_STORE_BUILD_REQUIRED",
    );
    await expect(verifyPreparedStorePackages({}, root, stage)).rejects.toThrow(
      "WINDOWS_STORE_BUILD_REQUIRED",
    );
    await expect(
      readFile(join(stage, "candidate-receipt.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const reply = await promisify(execFile)(
      process.execPath,
      ["scripts/build-store.mjs", "unused", stage],
      { cwd: process.cwd() },
    ).catch((e) => e);
    expect(reply.code).toBe(2);
    expect(reply.stderr).toContain("WINDOWS_STORE_BUILD_REQUIRED");
  });
  it("reads build inputs through the bounded held-file primitive and rejects oversized or duplicate authority fields", async () => {
    const root = await temporary(),
      path = join(root, "input.json"),
      inputs = {
        version: 1,
        purpose: "unsigned-store-upload-candidate",
        guiPayloadRoot: root,
        workerPayloadRoot: root,
        guiBuildNumber: 1,
        workerBuildNumber: 1,
        namespaceProfile: "packaged-classic-v1",
      };
    await writeFile(path, JSON.stringify(inputs));
    await expect(readStoreBuildInputsFile(path)).resolves.toEqual(inputs);
    await writeFile(
      path,
      JSON.stringify(inputs).replace('"version":1', '"version":0,"version":1'),
    );
    await expect(readStoreBuildInputsFile(path)).rejects.toThrow();
    await writeFile(path, Buffer.alloc(16385));
    await expect(readStoreBuildInputsFile(path)).rejects.toThrow();
  });
  it("uses only the exact approved SDK and a static guarded CMake pack recipe", async () => {
    expect(STORE_MAKEAPPX).toMatchObject({
      bytes: 584024,
      fileVersion: "10.0.26100.7705",
      sha256:
        "00fff202b71c1266b8c3899701e42b5468ea153b2b33a0a47215fe27695f16d0",
    });
    const recipe = await readFile("packaging/store/pack.cmake", "utf8");
    expect(recipe).toContain('pack /d "${package}" /p "${artifact}"');
    expect(recipe).toContain("STORE_PACK_INPUT_CHANGED");
    expect(recipe).not.toMatch(
      /COMMAND[^\n]*(?:signtool|powershell|cmd\.exe|Add-AppxPackage)|pack[^\n]*\/o|pack[^\n]*\/nv/u,
    );
  });

  describe("inline pack-time input checker", () => {
    async function fixture() {
      const root = await temporary(),
        payload = join(root, "payload"),
        input = join(root, "pack-inputs.json"),
        content = Buffer.from("owned");
      await mkdir(join(payload, "app"), { recursive: true });
      await writeFile(join(payload, "app/main.cjs"), content);
      const entries = [
        { path: "app/main.cjs", bytes: content.length, sha256: sha(content) },
      ];
      async function write(entriesValue: unknown = entries) {
        const bytes = Buffer.from(
          JSON.stringify({ version: 1, role: "gui", entries: entriesValue }),
        );
        await writeFile(input, bytes);
        return sha(bytes);
      }
      const hash = await write();
      const recipe = await readFile("packaging/store/pack.cmake", "utf8"),
        code = /set\(check_inputs_code \[==\[([^]*?)\]==\]\)/u.exec(
          recipe,
        )?.[1];
      if (!code) throw new Error("INLINE_PACK_CHECKER_REQUIRED");
      const check = (expectedHash = hash) =>
        promisify(execFile)(process.execPath, [
          "-e",
          code,
          input,
          payload,
          expectedHash,
          "gui",
        ]);
      return { payload, input, entries, write, check };
    }

    it("admits the actual fixture bytes and rejects a same-size mutation on the second pass", async () => {
      const f = await fixture();
      await expect(f.check()).resolves.toMatchObject({ stderr: "" });
      await writeFile(join(f.payload, "app/main.cjs"), "other");
      await expect(f.check()).rejects.toMatchObject({
        code: 1,
        stderr: "STORE_PACK_INPUT_CHANGED\n",
      });
    });

    it("rejects missing files, extra files and changed input authority without leaking paths", async () => {
      const missing = await fixture();
      await rm(join(missing.payload, "app/main.cjs"));
      await expect(missing.check()).rejects.toMatchObject({
        code: 1,
        stderr: "STORE_PACK_INPUTS_INVALID\n",
      });
      const extra = await fixture();
      await writeFile(join(extra.payload, "private-extra.txt"), "private");
      await expect(extra.check()).rejects.toMatchObject({
        code: 1,
        stderr: "STORE_PACK_FILE_SET_CHANGED\n",
      });
      const changed = await fixture();
      await changed.write([]);
      await expect(changed.check()).rejects.toMatchObject({
        code: 1,
        stderr: "STORE_PACK_INPUT_CHANGED\n",
      });
    });

    it.each([
      "../outside.dll",
      "app//main.cjs",
      "/absolute.dll",
      "C:/absolute.dll",
      "app\\escape.dll",
      "app/unsafe;file.dll",
      "app/$private.dll",
      'app/quote".dll',
    ])("rejects unsafe pack paths: %s", async (path) => {
      const f = await fixture(),
        hash = await f.write([{ ...f.entries[0], path }]);
      await expect(f.check(hash)).rejects.toMatchObject({
        code: 1,
        stderr: "STORE_PACK_INPUTS_INVALID\n",
      });
    });

    it("rejects duplicate/case-alias entries and nonregular payload leaves", async () => {
      const f = await fixture(),
        duplicateHash = await f.write([f.entries[0], f.entries[0]]);
      await expect(f.check(duplicateHash)).rejects.toMatchObject({ code: 1 });
      const aliasHash = await f.write([
        f.entries[0],
        { ...f.entries[0], path: "APP/MAIN.CJS" },
      ]);
      await expect(f.check(aliasHash)).rejects.toMatchObject({ code: 1 });
      const linkFixture = await fixture();
      await rm(join(linkFixture.payload, "app/main.cjs"));
      await symlink(
        linkFixture.input,
        join(linkFixture.payload, "app/main.cjs"),
      );
      await expect(linkFixture.check()).rejects.toMatchObject({ code: 1 });
    });

    it("rejects malformed byte/hash pins and admits zero-byte files", async () => {
      const f = await fixture();
      for (const row of [
        { ...f.entries[0], bytes: -1 },
        { ...f.entries[0], bytes: 1.5 },
        { ...f.entries[0], sha256: "A".repeat(64) },
        { ...f.entries[0], sha256: "a".repeat(63) },
      ]) {
        const hash = await f.write([row]);
        await expect(f.check(hash)).rejects.toMatchObject({ code: 1 });
      }
      await writeFile(join(f.payload, "app/main.cjs"), "");
      const hash = await f.write([
        { path: "app/main.cjs", bytes: 0, sha256: sha(Buffer.alloc(0)) },
      ]);
      await expect(f.check(hash)).resolves.toMatchObject({ stderr: "" });
    });
  });
});

describe("actual unsigned archive read-back", () => {
  const payload = {
    path: "app/MusicMute%20Local.exe",
    content: "owned-binary-fixture",
  };
  const generated = [
    { path: "AppxBlockMap.xml", content: "<BlockMap />" },
    { path: "[Content_Types].xml", content: "<Types />" },
  ];
  const pin = {
    path: "app/MusicMute Local.exe",
    bytes: Buffer.byteLength(payload.content),
    sha256: sha(Buffer.from(payload.content)),
  };
  async function archive(rows: Parameters<typeof zipBytes>[0]) {
    const root = await temporary(),
      path = join(root, "upload.msix");
    await writeFile(path, zipBytes(rows));
    return path;
  }
  it("streams every owned byte and generated metadata without extraction or installability claims", async () => {
    const path = await archive([payload, ...generated]);
    const result = await auditStoreUploadArchive(path, [pin]);
    expect(result).toMatchObject({
      inventoryFilesVerified: 1,
      generatedMetadataVerified: 2,
      signed: false,
      installable: false,
      releaseReady: false,
    });
    expect(result.sha256).toBe(sha(await readFile(path)));
  });
  it("supports SDK-style deflate and data descriptors using the held authority handle", async () => {
    const path = await archive([
      { ...payload, compressed: true, descriptor: true },
      ...generated.map((row) => ({ ...row, compressed: true })),
    ]);
    await expect(auditStoreUploadArchive(path, [pin])).resolves.toMatchObject({
      inventoryFilesVerified: 1,
    });
  });
  it.each([
    {
      trusted: "worker/node_modules/@scope/pkg+1/script (dev).tmpl",
      raw: "worker/node_modules/%40scope/pkg%2B1/script%20%28dev%29.tmpl",
    },
    {
      trusted: "worker/data/!#%&'()+,=@[]^`{}.txt",
      raw: "worker/data/%21%23%25%26%27%28%29%2B%2C%3D%40%5B%5D%5E%60%7B%7D.txt",
    },
    {
      trusted: "worker/data/literal%20name.txt",
      raw: "worker/data/literal%2520name.txt",
    },
  ])(
    "matches exact SDK part names derived from $trusted",
    async ({ trusted, raw }) => {
      const path = await archive([{ ...payload, path: raw }, ...generated]);
      await expect(
        auditStoreUploadArchive(path, [{ ...pin, path: trusted }]),
      ).resolves.toMatchObject({ inventoryFilesVerified: 1 });
    },
  );
  it("keeps trusted literal percent escapes distinct from encoded spaces", async () => {
    const path = await archive([
      payload,
      { ...payload, path: "app/MusicMute%2520Local.exe" },
      ...generated,
    ]);
    await expect(
      auditStoreUploadArchive(path, [
        pin,
        { ...pin, path: "app/MusicMute%20Local.exe" },
      ]),
    ).resolves.toMatchObject({ inventoryFilesVerified: 2 });
  });
  it.each([
    "app/MusicMute Local.exe",
    "app/MusicMute%2520Local.exe",
    "app%2FMusicMute%20Local.exe",
    "app/%4DusicMute%20Local.exe",
    "app/%2E%2E/MusicMute%20Local.exe",
  ])("does not decode or normalize the untrusted ZIP name %s", async (raw) => {
    await expect(
      auditStoreUploadArchive(
        await archive([{ ...payload, path: raw }, ...generated]),
        [pin],
      ),
    ).rejects.toThrow("STORE_ARCHIVE_INVALID");
  });
  it("requires uppercase canonical percent escapes", async () => {
    await expect(
      auditStoreUploadArchive(
        await archive([
          { ...payload, path: "worker/data/pkg%2bname.txt" },
          ...generated,
        ]),
        [{ ...pin, path: "worker/data/pkg+name.txt" }],
      ),
    ).rejects.toThrow("STORE_ARCHIVE_INVALID");
  });
  it("rejects a second unencoded alias of an encoded entry", async () => {
    await expect(
      auditStoreUploadArchive(
        await archive([payload, { ...payload, path: pin.path }, ...generated]),
        [pin],
      ),
    ).rejects.toThrow("STORE_ARCHIVE_INVALID");
  });
  it("requires local and central filenames to agree as raw encoded bytes", async () => {
    await expect(
      auditStoreUploadArchive(
        await archive([{ ...payload, localPath: pin.path }, ...generated]),
        [pin],
      ),
    ).rejects.toThrow("STORE_ARCHIVE_INVALID");
  });
  const emptyPayload = {
      path: "worker/runtime/python/package/__init__.py",
      content: "",
    },
    emptyPin = {
      path: emptyPayload.path,
      bytes: 0,
      sha256: sha(Buffer.alloc(0)),
    };
  it.each([false, true])(
    "reads an actual empty owned ZIP file with CRC zero (deflate=%s)",
    async (compressed) => {
      const path = await archive([
        payload,
        { ...emptyPayload, compressed, descriptor: compressed },
        ...generated,
      ]);
      await expect(
        auditStoreUploadArchive(path, [pin, emptyPin]),
      ).resolves.toMatchObject({ inventoryFilesVerified: 2 });
    },
  );
  it.each([
    { name: "negative size", bytes: -1, sha256: emptyPin.sha256 },
    { name: "fractional size", bytes: 0.5, sha256: emptyPin.sha256 },
    { name: "wrong empty digest", bytes: 0, sha256: "a".repeat(64) },
  ])("rejects an empty archive pin with $name", async ({ bytes, sha256 }) => {
    const path = await archive([payload, emptyPayload, ...generated]);
    await expect(
      auditStoreUploadArchive(path, [pin, { ...emptyPin, bytes, sha256 }]),
    ).rejects.toThrow("STORE_ARCHIVE_INVALID");
  });
  it.each([
    { name: "missing empty file", rows: [payload, ...generated] },
    {
      name: "changed empty file",
      rows: [payload, { ...emptyPayload, content: "x" }, ...generated],
    },
    {
      name: "corrupt empty CRC",
      rows: [payload, { ...emptyPayload, crc: 123 }, ...generated],
    },
  ])("rejects $name during actual ZIP readback", async ({ rows }) => {
    await expect(
      auditStoreUploadArchive(await archive(rows), [pin, emptyPin]),
    ).rejects.toThrow("STORE_ARCHIVE_INVALID");
  });
  it("rejects an unlisted empty archive file", async () => {
    await expect(
      auditStoreUploadArchive(
        await archive([payload, emptyPayload, ...generated]),
        [pin],
      ),
    ).rejects.toThrow("STORE_ARCHIVE_INVALID");
  });
  it.each([
    { name: "missing payload", rows: generated },
    {
      name: "changed payload",
      rows: [{ ...payload, content: "wrong-binary-fixture" }, ...generated],
    },
    {
      name: "extra executable",
      rows: [
        payload,
        { path: "app/foreign.exe", content: "foreign" },
        ...generated,
      ],
    },
    {
      name: "signature",
      rows: [
        payload,
        { path: "AppxSignature.p7x", content: "signed" },
        ...generated,
      ],
    },
    {
      name: "duplicate alias",
      rows: [
        payload,
        { ...payload, path: payload.path.toUpperCase() },
        ...generated,
      ],
    },
    {
      name: "symlink",
      rows: [{ ...payload, attributes: (0xa000 << 16) >>> 0 }, ...generated],
    },
    {
      name: "traversal",
      rows: [
        payload,
        { path: "app/../private", content: "foreign" },
        ...generated,
      ],
    },
    { name: "missing generated metadata", rows: [payload, generated[0]!] },
    { name: "CRC corruption", rows: [{ ...payload, crc: 123 }, ...generated] },
    { name: "encrypted entry", rows: [{ ...payload, flags: 1 }, ...generated] },
    {
      name: "different local filename",
      rows: [
        { ...payload, localPath: "app/untrusted-other.exe" },
        ...generated,
      ],
    },
    {
      name: "FIFO entry",
      rows: [{ ...payload, attributes: (0x1000 << 16) >>> 0 }, ...generated],
    },
  ])("rejects $name in actual receiving ZIP bytes", async ({ rows }) => {
    await expect(
      auditStoreUploadArchive(await archive(rows), [pin]),
    ).rejects.toThrow("STORE_ARCHIVE_INVALID");
  });
  it("rejects hardlink aliases and malformed archive bytes", async () => {
    const path = await archive([payload, ...generated]);
    await link(path, path + ".alias");
    await expect(auditStoreUploadArchive(path, [pin])).rejects.toThrow();
    const root = await temporary(),
      bad = join(root, "bad.msix");
    await writeFile(bad, "not an archive");
    await expect(auditStoreUploadArchive(bad, [pin])).rejects.toThrow(
      "STORE_ARCHIVE_INVALID",
    );
  });
});
