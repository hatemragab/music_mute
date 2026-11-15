import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdir,
  copyFile,
  cp,
  lstat,
  readdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
  link,
  symlink,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { finished } from "node:stream/promises";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { ACCEPTANCE_CASES } from "../acceptance/manifest.js";
import { nativeAcceptanceSourceDigest } from "../acceptance/native-run.js";
import { caseDigest, targetDigest } from "../acceptance/plan.js";
import { parseStoreResourceIndexBytes } from "../src/main/browser/store-resource-index.js";
import {
  buildStoreGuiDirectory,
  createStoreGuiBuildWorkspace,
  inspectStoreElectronArchive,
  parseStoreGuiBuildInputs,
  parseStoreGuiBuildInputsBytes,
  stageStoreGuiResources,
  storeGuiAfterExtractHook,
  storeGuiCompiledPayload,
  verifyStoreGuiNativeProvenance,
  STORE_GUI_ELECTRON,
  STORE_GUI_NATIVE_FILES,
  type StoreGuiBuildInputs,
} from "../packaging/store/gui.js";

const require = createRequire(import.meta.url),
  execute = promisify(execFile);
const component = resolve(import.meta.dirname, "..");
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function temporary() {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "musicmute-store-gui-test-")),
  );
  roots.push(directory);
  return directory;
}

async function guiWorkspaceFixture(root: string) {
  const repository = join(root, "source"),
    componentRoot = join(repository, "windows-desktop"),
    workspaceRoot = join(root, "build-work");
  const files = [
    "windows-desktop/package.json",
    "windows-desktop/package-lock.json",
    "windows-desktop/tsconfig.json",
    "windows-desktop/scripts/build.mjs",
    "windows-desktop/scripts/agent-build-inputs.mjs",
    "windows-desktop/packaging/validate-assets.ts",
    "windows-desktop/packaging/inventory.cjs",
    "windows-desktop/packaging/shared-extension.mjs",
    "windows-desktop/packaging/store/document-json.ts",
    "windows-desktop/packaging/store/inventory.ts",
    "windows-desktop/packaging/notices/google-branding.txt",
    "windows-desktop/src/main.ts",
    "windows-desktop/acceptance/runner.ts",
    "windows-desktop/node_modules/esbuild/tool.exe",
    "chrome-extension/package.json",
    "chrome-extension/tsconfig.json",
    "chrome-extension/scripts/build-extension.mjs",
    "chrome-extension/scripts/package-chrome.mjs",
    "chrome-extension/macos/Resources/Fonts/NotoSansArabic.ttf",
    "chrome-extension/macos/Resources/licenses/noto_sans_arabic_ofl.txt",
    "chrome-extension/src/shared/protocol.ts",
    "chrome-extension/node_modules/esbuild/package.json",
    "chrome-extension/node_modules/@esbuild/win32-x64/tool.exe",
    "worker/package.json",
    "worker/tsconfig.json",
    "worker/src/runtime.ts",
    "worker/protocol/v1/protocol.ts",
    "worker/native/windows-consumer/main.cpp",
  ];
  for (const key of files) {
    const file = join(repository, ...key.split("/"));
    await mkdir(resolve(file, ".."), { recursive: true });
    await writeFile(
      file,
      key.endsWith(".json") ? "{}\n" : "synthetic fixture\n",
    );
  }
  return { repository, componentRoot, workspaceRoot };
}

describe("Store GUI isolated physical build inputs", () => {
  it("bundles genuine Store Worker and session entries with their manifest and inventory parsers from the isolated source copy", async () => {
    const fixture = await guiWorkspaceFixture(await temporary());
    for (const key of [
      "windows-desktop/src",
      "worker/src",
      "worker/protocol",
      "chrome-extension/src",
    ])
      await cp(resolve(component, "..", key), join(fixture.repository, key), {
        recursive: true,
      });
    const parsers = [
      "packaging/store/document-json.ts",
      "packaging/store/inventory.ts",
    ];
    for (const parser of parsers)
      await copyFile(
        join(component, parser),
        join(fixture.componentRoot, parser),
      );
    const workspace = await createStoreGuiBuildWorkspace(
      fixture.componentRoot,
      fixture.workspaceRoot,
    );
    const result = await build({
      entryPoints: [
        join(workspace.componentRoot, "src/main/browser/store-worker-code.ts"),
        join(workspace.componentRoot, "src/main/session/store-node-issuer.ts"),
      ],
      bundle: true,
      platform: "node",
      format: "esm",
      // This regression resolves real relative source imports; the fixture
      // deliberately does not install the Electron or ZIP npm runtimes.
      external: ["electron", "yauzl"],
      outdir: join(workspace.componentRoot, "dist/regression"),
      write: false,
      metafile: true,
    });
    for (const parser of parsers)
      expect(
        Object.keys(result.metafile!.inputs).some((name) =>
          name.endsWith(parser),
        ),
      ).toBe(true);
    const output = result.outputFiles!.map((file) => file.text).join("\n");
    expect(output).toContain("STORE_BUILD_JSON_INVALID");
    expect(output).toContain("STORE_INVENTORY_INVALID");
    await workspace.verifySource();
  });

  it("verifies native role provenance against the copied current Worker native sources", async () => {
    const root = await temporary(),
      fixture = await guiWorkspaceFixture(root),
      nativeSource = resolve(component, "../worker/native/windows-consumer"),
      copiedSource = join(fixture.repository, "worker/native/windows-consumer");
    for (const name of await readdir(nativeSource))
      await copyFile(join(nativeSource, name), join(copiedSource, name));
    const value = await inputs(root),
      workspace = await createStoreGuiBuildWorkspace(
        fixture.componentRoot,
        fixture.workspaceRoot,
      );
    await expect(
      verifyStoreGuiNativeProvenance(value, workspace.componentRoot),
    ).resolves.toMatchObject({
      sourceSha256: value.nativeBuild.sourceSha256,
    });
    await workspace.verifySource();
  });

  it("runs a copied fixture build with intact sibling topology and preserves every original tool identity field", async () => {
    const fixture = await guiWorkspaceFixture(await temporary()),
      originalTool = join(
        fixture.componentRoot,
        "node_modules/esbuild/tool.exe",
      ),
      before = await lstat(originalTool, { bigint: true });
    await writeFile(
      join(fixture.componentRoot, "scripts/build.mjs"),
      `
import {chmod, mkdir, readFile, writeFile} from 'node:fs/promises';
await readFile('../chrome-extension/src/shared/protocol.ts');
await readFile('../worker/src/runtime.ts');
await chmod('node_modules/esbuild/tool.exe', 0o600);
await mkdir('dist');
await writeFile('dist/fixture-output.txt', 'copied fixture only');
`,
    );
    for (const key of [
      "windows-desktop/.env",
      "private/credentials.json",
      "windows-desktop/dist/stale.js",
    ]) {
      const file = join(fixture.repository, ...key.split("/"));
      await mkdir(resolve(file, ".."), { recursive: true });
      await writeFile(file, "preserved fixture");
    }
    const workspace = await createStoreGuiBuildWorkspace(
        fixture.componentRoot,
        fixture.workspaceRoot,
      ),
      copiedTool = join(
        workspace.componentRoot,
        "node_modules/esbuild/tool.exe",
      );
    expect((await lstat(copiedTool)).nlink).toBe(1);
    expect((await lstat(copiedTool, { bigint: true })).ino).not.toBe(
      before.ino,
    );
    await execute(
      process.execPath,
      [join(workspace.componentRoot, "scripts/build.mjs")],
      { cwd: workspace.componentRoot },
    );
    await workspace.verifySource();
    const after = await lstat(originalTool, { bigint: true });
    for (const key of [
      "dev",
      "ino",
      "size",
      "nlink",
      "ctimeNs",
      "mtimeNs",
      "birthtimeNs",
    ] as const)
      expect(after[key]).toBe(before[key]);
    expect(await readFile(copiedTool)).toEqual(await readFile(originalTool));
    expect(
      await readFile(
        join(workspace.componentRoot, "dist/fixture-output.txt"),
        "utf8",
      ),
    ).toBe("copied fixture only");
    await expect(
      lstat(join(fixture.componentRoot, "dist/fixture-output.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    for (const key of [
      "windows-desktop/.env",
      "private/credentials.json",
      "windows-desktop/dist/stale.js",
    ])
      await expect(
        lstat(join(fixture.workspaceRoot, ...key.split("/"))),
      ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["changed", "added"])(
    "rejects %s source inputs after copy instead of dropping identity checks",
    async (kind) => {
      const fixture = await guiWorkspaceFixture(await temporary()),
        workspace = await createStoreGuiBuildWorkspace(
          fixture.componentRoot,
          fixture.workspaceRoot,
        );
      await writeFile(
        join(
          fixture.componentRoot,
          "src",
          kind === "added" ? "extra.ts" : "main.ts",
        ),
        "changed fixture",
      );
      await expect(workspace.verifySource()).rejects.toThrow(
        "STORE_GUI_BUILD_INPUT_CHANGED",
      );
    },
  );

  it("rejects changed copied tool bytes while allowing the original source to remain untouched", async () => {
    const fixture = await guiWorkspaceFixture(await temporary()),
      workspace = await createStoreGuiBuildWorkspace(
        fixture.componentRoot,
        fixture.workspaceRoot,
      );
    await writeFile(
      join(workspace.componentRoot, "node_modules/esbuild/tool.exe"),
      "altered copied tool",
    );
    await expect(workspace.verifySource()).rejects.toThrow(
      "STORE_GUI_BUILD_COPY_CHANGED",
    );
    expect(
      await readFile(
        join(fixture.componentRoot, "node_modules/esbuild/tool.exe"),
        "utf8",
      ),
    ).toBe("synthetic fixture\n");
  });

  it.each(["symbolic", "hard"])(
    "rejects a %s input alias before creating any copy",
    async (kind) => {
      const fixture = await guiWorkspaceFixture(await temporary()),
        source = join(fixture.componentRoot, "src/main.ts"),
        alias = join(fixture.componentRoot, "src/alias.ts");
      if (kind === "symbolic") await symlink(source, alias);
      else await link(source, alias);
      await expect(
        createStoreGuiBuildWorkspace(
          fixture.componentRoot,
          fixture.workspaceRoot,
        ),
      ).rejects.toThrow();
      await expect(lstat(fixture.workspaceRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("rejects directory case aliases and source-overlapping or preexisting workspaces", async () => {
    const fixture = await guiWorkspaceFixture(await temporary());
    await expect(
      createStoreGuiBuildWorkspace(
        fixture.componentRoot,
        join(fixture.repository, "build-work"),
      ),
    ).rejects.toThrow("STORE_GUI_BUILD_WORKSPACE_INVALID");
    await mkdir(fixture.workspaceRoot);
    await writeFile(
      join(fixture.workspaceRoot, "preserved.txt"),
      "do not adopt",
    );
    await expect(
      createStoreGuiBuildWorkspace(
        fixture.componentRoot,
        fixture.workspaceRoot,
      ),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(
      await readFile(join(fixture.workspaceRoot, "preserved.txt"), "utf8"),
    ).toBe("do not adopt");
    if (process.platform !== "win32") {
      for (const name of ["Case", "case"]) {
        const file = join(fixture.componentRoot, "src", name, "entry.ts");
        await mkdir(resolve(file, ".."), { recursive: true });
        await writeFile(file, "fixture");
      }
      const names = await readdir(join(fixture.componentRoot, "src"));
      if (names.includes("Case") && names.includes("case"))
        await expect(
          createStoreGuiBuildWorkspace(
            fixture.componentRoot,
            join(dirname(fixture.workspaceRoot), "fresh-work"),
          ),
        ).rejects.toThrow("STORE_GUI_BUILD_INPUT_INVALID");
    }
  });
});
async function extractedFrameworkFixture(root: string) {
  const stage = join(root, "candidate"),
    outDir = join(stage, "electron-output"),
    appOutDir = join(outDir, "win-unpacked"),
    resources = join(appOutDir, "resources"),
    { createPackage } =
      require("@electron/asar") as typeof import("@electron/asar");
  await mkdir(resources, { recursive: true });
  for (const name of ["app", "default_app"]) {
    const source = join(root, `${name}-source`);
    await mkdir(source);
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({ name, description: "Synthetic hook fixture only" }),
    );
    await finished(
      await createPackage(source, join(resources, `${name}.asar`)),
      {
        cleanup: true,
      },
    );
  }
  const defaultArchive = join(resources, "default_app.asar"),
    bytes = await readFile(defaultArchive),
    framework = [
      {
        path: "resources/default_app.asar",
        bytes: bytes.length,
        sha256: hash(bytes),
      },
    ],
    context = { appOutDir, outDir, electronPlatformName: "win32", arch: 1 };
  return { stage, resources, defaultArchive, bytes, framework, context };
}

describe("Store GUI afterExtract ownership and pinned archive cleanup", () => {
  it("removes only the verified default archive before the real pinned builder computes its single app integrity entry", async () => {
    const root = await temporary(),
      fixture = await extractedFrameworkFixture(root),
      application = join(fixture.resources, "app.asar"),
      beforeApp = await readFile(application),
      { computeData } =
        require("app-builder-lib/out/asar/integrity") as typeof import("app-builder-lib/out/asar/integrity"),
      options = {
        resourcesPath: fixture.resources,
        resourcesRelativePath: "resources",
        resourcesDestinationPath: fixture.resources,
        extraResourceMatchers: null,
      };
    expect(Object.keys(await computeData(options))).toEqual([
      join("resources", "app.asar"),
      join("resources", "default_app.asar"),
    ]);
    await storeGuiAfterExtractHook(
      fixture.stage,
      fixture.framework,
    )(fixture.context);
    await expect(readFile(fixture.defaultArchive)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(application)).toEqual(beforeApp);
    const integrity = await computeData(options);
    expect(Object.keys(integrity)).toEqual([join("resources", "app.asar")]);
    const { getRawHeader } =
      require("@electron/asar") as typeof import("@electron/asar");
    expect(integrity[join("resources", "app.asar")]).toEqual({
      algorithm: "SHA256",
      hash: hash(Buffer.from(getRawHeader(application).headerString)),
    });
  });

  it.each(["appOutDir", "outDir", "platform", "arch"])(
    "rejects a foreign %s before touching an extracted archive",
    async (field) => {
      const fixture = await extractedFrameworkFixture(await temporary()),
        context = { ...fixture.context };
      if (field === "appOutDir") context.appOutDir += "-foreign";
      else if (field === "outDir") context.outDir += "-foreign";
      else if (field === "platform") context.electronPlatformName = "darwin";
      else context.arch = 0;
      await expect(
        storeGuiAfterExtractHook(fixture.stage, fixture.framework)(context),
      ).rejects.toThrow("STORE_GUI_EXTRACTED_OUTPUT_DENIED");
      expect(await readFile(fixture.defaultArchive)).toEqual(fixture.bytes);
    },
  );

  it("rejects changed bytes and missing original framework provenance without removing either archive", async () => {
    const fixture = await extractedFrameworkFixture(await temporary()),
      changed = Buffer.from(fixture.bytes);
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    await writeFile(fixture.defaultArchive, changed);
    await expect(
      storeGuiAfterExtractHook(
        fixture.stage,
        fixture.framework,
      )(fixture.context),
    ).rejects.toThrow("STORE_GUI_DEFAULT_ARCHIVE_CHANGED");
    expect(await readFile(fixture.defaultArchive)).toEqual(changed);
    expect(() => storeGuiAfterExtractHook(fixture.stage, [])).toThrow(
      "STORE_GUI_DEFAULT_ARCHIVE_MISSING",
    );
  });

  it.each(["symbolic", "hard"])(
    "rejects a %s link even when its target bytes match the pinned archive",
    async (kind) => {
      const root = await temporary(),
        fixture = await extractedFrameworkFixture(root),
        outside = join(root, "preserved-source.asar");
      await writeFile(outside, fixture.bytes);
      await rm(fixture.defaultArchive);
      if (kind === "symbolic") await symlink(outside, fixture.defaultArchive);
      else await link(outside, fixture.defaultArchive);
      await expect(
        storeGuiAfterExtractHook(
          fixture.stage,
          fixture.framework,
        )(fixture.context),
      ).rejects.toThrow();
      expect(await readFile(outside)).toEqual(fixture.bytes);
      expect(await readFile(fixture.defaultArchive)).toEqual(fixture.bytes);
    },
  );
});
async function preserveAsarReadbackFailure(
  archive: string,
  expected: Buffer,
  actual: Buffer,
) {
  const destination = await mkdtemp(
    join(tmpdir(), "musicmute-store-asar-readback-failure-"),
  );
  const handle = await open(archive, "r");
  try {
    const before = await handle.stat({ bigint: true }),
      header = Buffer.alloc(65536);
    const read = await handle.read(header, 0, header.length, 0);
    const after = await handle.stat({ bigint: true });
    const pin = (info: typeof before) =>
      Object.fromEntries(
        ["dev", "ino", "size", "nlink", "birthtimeNs", "mtimeNs"].map(
          (name) => [name, String(info[name as keyof typeof before])],
        ),
      );
    await Promise.all([
      writeFile(
        join(destination, "expected-index.bin"),
        expected.subarray(0, 65536),
        { flag: "wx" },
      ),
      writeFile(
        join(destination, "archive-index.bin"),
        actual.subarray(0, 65536),
        { flag: "wx" },
      ),
      writeFile(
        join(destination, "archive-header.bin"),
        header.subarray(0, read.bytesRead),
        { flag: "wx" },
      ),
      writeFile(
        join(destination, "readback.json"),
        JSON.stringify({
          version: 1,
          archive,
          before: pin(before),
          after: pin(after),
          expected: { bytes: expected.length, sha256: hash(expected) },
          actual: { bytes: actual.length, sha256: hash(actual) },
          header: {
            bytes: read.bytesRead,
            sha256: hash(header.subarray(0, read.bytesRead)),
          },
        }) + "\n",
        { flag: "wx" },
      ),
    ]);
  } finally {
    await handle.close();
  }
  console.error("STORE_GUI_ASAR_READBACK_EVIDENCE", destination);
}
function pe(execution = "asInvoker", machine = 0x8664) {
  const { NtExecutable, NtExecutableResource } =
    require("resedit") as typeof import("resedit");
  const executable = NtExecutable.createEmpty(false, false);
  executable.newHeader.fileHeader.machine = machine;
  const resources = NtExecutableResource.from(executable);
  resources.replaceResourceEntryFromString(
    24,
    1,
    1033,
    `<assembly><requestedExecutionLevel level="${execution}" uiAccess="false"/></assembly>`,
  );
  resources.outputResource(executable);
  return Buffer.from(executable.generate());
}
async function pinned(path: string, bytes: Buffer) {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, bytes, { flag: "wx" });
  return { path, bytes: bytes.length, sha256: hash(bytes) };
}
/** Synthetic guarded-build records qualify only this unsigned source-staging
 * fixture. They never launch a binary or create actual Store/Windows evidence. */
async function inputs(
  root: string,
  machine = 0x8664,
  execution = "asInvoker",
): Promise<StoreGuiBuildInputs> {
  const nativeRoot = join(
      root,
      "native",
      "MusicMuteAcceptance-00000000-0000-4000-8000-000000000001",
    ),
    directory = join(nativeRoot, "native-build", "Release");
  const sourceSha256 = await nativeAcceptanceSourceDigest(
    resolve(component, ".."),
  );
  const target = {
    version: 2 as const,
    scope: "isolated-native" as const,
    name: "StoreGuiFixture",
    sourceSha256,
    os: {
      major: 10 as const,
      build: 26200,
      edition: "workstation" as const,
      nativeArch: "x64" as const,
      processArch: "x64" as const,
    },
    gpu: null,
  };
  const observation = await pinned(
    join(nativeRoot, "native-observation.json"),
    Buffer.from(
      JSON.stringify({
        version: 1,
        target,
        logs: ["configure", "compile", "describe", "ctest"].map((step) => ({
          step,
          exitCode: 0,
          toolExitCode: 0,
          terminationReason: "completed",
          bytes: 1,
          sha256: hash(Buffer.from("fixture")),
          sanitizedOutput: "Synthetic source-staging fixture only",
        })),
        failedToolDiagnostics: [],
        installedAppActionsExecuted: false,
      }) + "\n",
    ),
  );
  const evidence = ["native-build", "native-security-fixtures"].map((id) => ({
    version: 1,
    caseId: id,
    caseSha256: caseDigest(ACCEPTANCE_CASES.find((row) => row.id === id)!),
    targetSha256: targetDigest(target),
    source: "native",
    state: "passed",
    at: "2026-10-12T00:00:00.000Z",
    observation: "Synthetic source-staging fixture only",
    artifact: "native-observation.json",
    artifactSha256: observation.sha256,
    cleanup: "confirmed",
  }));
  const evidenceLedger = await pinned(
    join(nativeRoot, "evidence-ledger.json"),
    Buffer.from(JSON.stringify(evidence) + "\n"),
  );
  const executables = [];
  for (const name of STORE_GUI_NATIVE_FILES) {
    const entry = await pinned(join(directory, name), pe(execution, machine));
    executables.push({ ...entry, path: name });
  }
  const publicConfiguration = await pinned(
    join(root, "inputs", "desktop-public-config.json"),
    Buffer.from(
      JSON.stringify({
        backend_base_url: "https://api.music-mute.com",
        firebase_api_key: "test-public-api-key-000000000",
        firebase_project_id: "musicmute-test",
        google_desktop_client_id: "123456-tests.apps.googleusercontent.com",
      }) + "\n",
    ),
  );
  return {
    version: 1,
    purpose: "unsigned-store-gui-directory",
    appBuildNumber: 17,
    electronArchivePath: join(root, "framework-input", STORE_GUI_ELECTRON.file),
    publicConfiguration,
    nativeBuild: {
      directory,
      sourceSha256,
      observation,
      evidenceLedger,
      executables,
    },
  };
}
describe("Store GUI source staging", () => {
  it("binds the actual compiled payload census to executed graphs and rejects stale or missing renderer artifacts", async () => {
    const { executedBuildGraphs, verifyLicensedBuildAssets } =
      require("../packaging/inventory.cjs") as {
        executedBuildGraphs(value: unknown): unknown[];
        verifyLicensedBuildAssets(
          root: string,
          dist: string,
        ): Promise<string[]>;
      };
    const { packageInventory } =
      await import("../packaging/validate-assets.js");
    const graphs = JSON.parse(
      await readFile(join(component, "dist/build-metafiles.json"), "utf8"),
    ) as unknown[];
    const built = await packageInventory(join(component, "dist")),
      executed = executedBuildGraphs(graphs),
      licensed = await verifyLicensedBuildAssets(
        component,
        join(component, "dist"),
      );
    expect(storeGuiCompiledPayload(built, executed, licensed)).toContain(
      "renderer/app.js",
    );
    for (const changed of [
      [...built, "renderer/obsolete-code.js"],
      [...built, "licenses/obsolete-dependency.txt"],
      built.filter((name) => name !== "renderer/app.js"),
      built.filter((name) => name !== "renderer/fonts/NotoSansArabic.ttf"),
    ])
      expect(() =>
        storeGuiCompiledPayload(changed, executed, licensed),
      ).toThrow("STORE_GUI_SOURCE_BUILD_CENSUS_INVALID");
  });
  it("stages real compiled code, complete fresh shared extension, licenses and a receiving-valid v2 helper seal", async () => {
    const root = await temporary(),
      value = await inputs(root),
      stage = join(root, "candidate");
    const result = await stageStoreGuiResources(value, component, stage);
    expect(result.receipt).toMatchObject({
      sourceResourcesStaged: true,
      electronDirectoryBuilt: false,
      signed: false,
      installable: false,
      releaseReady: false,
      functionalStoreFlowsVerified: false,
      published: false,
    });
    const seal = parseStoreResourceIndexBytes(
      await readFile(join(stage, "application/packaged-resources.json")),
    );
    expect(seal.authority).toMatchObject({
      kind: "microsoft-store",
      role: "gui",
      packageVersion: "0.1.0.0",
      protocolAbi: 1,
    });
    expect(seal.buildNumber).toBe(17);
    const browserRegistration = await readFile(
      join(stage, "resources/native/com.musicmute.local.json"),
    );
    expect(JSON.parse(browserRegistration.toString("utf8"))).toEqual({
      name: "com.musicmute.local",
      description: "MusicMute Windows companion",
      path: "../../MusicMuteChromeHost.exe",
      type: "stdio",
      allowed_origins: ["chrome-extension://acmgefmmndomcpdlgnafkjbgobinllep/"],
    });
    expect(
      seal.entries.find(
        (entry) =>
          entry.placement === "resources" &&
          entry.path === "native/com.musicmute.local.json",
      ),
    ).toMatchObject({
      bytes: browserRegistration.length,
      sha256: hash(browserRegistration),
    });
    for (const entry of seal.entries) {
      const bytes = await readFile(
        join(
          stage,
          entry.placement === "resources" ? "resources" : "root",
          entry.path,
        ),
      );
      expect({ bytes: bytes.length, sha256: hash(bytes) }).toEqual({
        bytes: entry.bytes,
        sha256: entry.sha256,
      });
    }
    const extension = JSON.parse(
      await readFile(join(stage, "resources/extension/inventory.json"), "utf8"),
    ) as { entries: Array<{ path: string }> };
    expect(extension.entries.length).toBeGreaterThan(15);
    expect(extension.entries.some((row) => row.path === "popup.html")).toBe(
      true,
    );
    expect(extension.entries.some((row) => row.path === "notices.txt")).toBe(
      true,
    );
    expect(
      (await readFile(join(stage, "application/dist/main/main.cjs"))).equals(
        await readFile(join(component, "dist/main/main.cjs")),
      ),
    ).toBe(true);
    for (const name of [
      "electron_mit.txt",
      "noto_sans_arabic_ofl.txt",
      "google_branding.txt",
    ])
      expect(
        (await readFile(join(stage, "application/dist/licenses", name))).equals(
          await readFile(join(component, "dist/licenses", name)),
        ),
      ).toBe(true);
    expect(
      seal.entries.some((row) =>
        /runtime-metadata|runtime-source|update-channel|account-authority/u.test(
          row.path,
        ),
      ),
    ).toBe(false);
    const { createPackage, extractFile } =
      require("@electron/asar") as typeof import("@electron/asar");
    const archive = join(root, "unsigned-source-only.asar");
    const sourceIndex = await readFile(
      join(stage, "application/packaged-resources.json"),
    );
    const archiveWriter = await createPackage(
      join(stage, "application"),
      archive,
    );
    // ASAR3.4.1 returns the fs.WriteStream after end(), not after its final
    // writes/close. Join this exact writer before reading sealed bytes.
    await finished(archiveWriter, { cleanup: true });
    const archivedIndex = extractFile(archive, "packaged-resources.json");
    // Distinguish archive-byte readback from receiving-schema rejection if
    // fixture I/O fails under concurrent suite load.
    if (!archivedIndex.equals(sourceIndex))
      await preserveAsarReadbackFailure(archive, sourceIndex, archivedIndex);
    expect(archivedIndex.equals(sourceIndex)).toBe(true);
    expect(parseStoreResourceIndexBytes(archivedIndex)).toEqual(seal);
    const { verifyPackagedLicensedAssets } =
      require("../packaging/inventory.cjs") as {
        verifyPackagedLicensedAssets(
          path: string,
          source: string,
        ): Promise<unknown>;
      };
    await expect(
      verifyPackagedLicensedAssets(archive, component),
    ).resolves.toBeDefined();
    await expect(
      stageStoreGuiResources(value, component, stage),
    ).rejects.toThrow("STORE_GUI_STAGE_EXISTS");
  }, 30000);
  it("refuses an absent required native input before creating any stage", async () => {
    const root = await temporary(),
      value = await inputs(root),
      stage = join(root, "candidate");
    await rm(join(value.nativeBuild.directory, "MusicMuteChromeHost.exe"));
    await expect(
      stageStoreGuiResources(value, component, stage),
    ).rejects.toThrow();
    await expect(
      readFile(join(stage, "gui-source-receipt.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each([
    [0xaa64, "asInvoker"],
    [0x8664, "requireAdministrator"],
  ])(
    "rejects actual wrong-machine or elevated PE resources (%s,%s)",
    async (machine, execution) => {
      const root = await temporary(),
        value = await inputs(root, machine as number, execution as string),
        stage = join(root, "candidate");
      await expect(
        stageStoreGuiResources(value, component, stage),
      ).rejects.toThrow();
      await expect(
        readFile(join(stage, "gui-source-receipt.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it("rejects stale native source/build records and unconfirmed cleanup", async () => {
    const root = await temporary(),
      value = await inputs(root);
    await expect(
      verifyStoreGuiNativeProvenance(
        {
          ...value,
          nativeBuild: { ...value.nativeBuild, sourceSha256: "a".repeat(64) },
        },
        component,
      ),
    ).rejects.toThrow();
    const rows = JSON.parse(
      await readFile(value.nativeBuild.evidenceLedger.path, "utf8"),
    ) as Array<Record<string, unknown>>;
    rows[0]!.state = "failed";
    rows[0]!.cleanup = "unconfirmed";
    const bytes = Buffer.from(JSON.stringify(rows) + "\n");
    await writeFile(value.nativeBuild.evidenceLedger.path, bytes);
    await expect(
      verifyStoreGuiNativeProvenance(
        {
          ...value,
          nativeBuild: {
            ...value.nativeBuild,
            evidenceLedger: {
              ...value.nativeBuild.evidenceLedger,
              bytes: bytes.length,
              sha256: hash(bytes),
            },
          },
        },
        component,
      ),
    ).rejects.toThrow("STORE_GUI_NATIVE_PROVENANCE_INVALID");
  });
  it("rejects modified public input, hardlinks and canonical-path aliases", async () => {
    const root = await temporary(),
      value = await inputs(root),
      stage = join(root, "candidate");
    await writeFile(value.publicConfiguration.path, "changed");
    await expect(
      stageStoreGuiResources(value, component, stage),
    ).rejects.toThrow("STORE_GUI_INPUT_CHANGED");
    const native = join(value.nativeBuild.directory, "musicmute-native.exe");
    await link(native, join(root, "native-alias.exe"));
    await expect(
      stageStoreGuiResources(value, component, stage),
    ).rejects.toThrow();
    const alias = join(root, "alias");
    await symlink(value.nativeBuild.directory, alias, "dir");
    await expect(
      stageStoreGuiResources(
        {
          ...value,
          nativeBuild: {
            ...value.nativeBuild,
            directory: join(alias, "..", "alias"),
          },
        },
        component,
        stage,
      ),
    ).rejects.toThrow();
  });
  it("rejects extra public credentials even when their input pin is refreshed", async () => {
    const root = await temporary(),
      value = await inputs(root),
      bytes = Buffer.from(
        JSON.stringify({
          backend_base_url: "https://api.music-mute.com",
          firebase_api_key: "test-public-api-key-000000000",
          firebase_project_id: "musicmute-test",
          google_desktop_client_id: "123456-tests.apps.googleusercontent.com",
          client_secret: "do-not-stage",
        }),
      );
    await writeFile(value.publicConfiguration.path, bytes);
    await expect(
      stageStoreGuiResources(
        {
          ...value,
          publicConfiguration: {
            ...value.publicConfiguration,
            bytes: bytes.length,
            sha256: hash(bytes),
          },
        },
        component,
        join(root, "candidate"),
      ),
    ).rejects.toThrow("PACKAGE_PRIVATE_MATERIAL");
  });
  it("keeps the real Windows builder unavailable on other hosts before input reads or writes", async () => {
    if (process.platform === "win32") return;
    const root = await temporary();
    await expect(
      buildStoreGuiDirectory({}, component, join(root, "candidate")),
    ).rejects.toThrow("WINDOWS_STORE_BUILD_REQUIRED");
    const result = await execute(
      process.execPath,
      ["scripts/build-store-gui.mjs", "unused", join(root, "candidate")],
      { cwd: component },
    ).catch((error: unknown) => error as { code: number; stderr: string });
    expect(result).toMatchObject({ code: 2 });
    expect((result as { stderr: string }).stderr).toContain(
      "WINDOWS_STORE_BUILD_REQUIRED",
    );
  });
});
describe("Store GUI closed inputs", () => {
  it("requires actual selected files and explicit positive build number, without signing claims or getters", async () => {
    const root = await temporary(),
      value = await inputs(root);
    expect(parseStoreGuiBuildInputs(value)).toEqual(value);
    expect(
      parseStoreGuiBuildInputsBytes(Buffer.from(JSON.stringify(value))),
    ).toEqual(value);
    for (const changed of [
      { ...value, appBuildNumber: 0 },
      { ...value, publisherSha256: "a".repeat(64) },
      { ...value, purpose: "installable" },
      {
        ...value,
        nativeBuild: {
          ...value.nativeBuild,
          executables: value.nativeBuild.executables.slice(1),
        },
      },
      {
        ...value,
        electronArchivePath: join(root, "electron-v44.7.0-darwin-arm64.zip"),
      },
      {
        ...value,
        nativeBuild: {
          ...value.nativeBuild,
          executables: value.nativeBuild.executables.map((row) => ({
            ...row,
            path: row.path.toLowerCase(),
          })),
        },
      },
    ])
      expect(() => parseStoreGuiBuildInputs(changed)).toThrow();
    const getter = { ...value };
    Object.defineProperty(getter, "nativeBuild", {
      get() {
        throw new Error("GETTER_EXECUTED");
      },
      enumerable: true,
    });
    expect(() => parseStoreGuiBuildInputs(getter)).toThrow(
      "STORE_GUI_INPUT_INVALID",
    );
    expect(() =>
      parseStoreGuiBuildInputsBytes(
        Buffer.from(
          JSON.stringify(value).replace(
            '"version":1',
            '"version":1,"version":1',
          ),
        ),
      ),
    ).toThrow();
    expect(() =>
      parseStoreGuiBuildInputsBytes(Buffer.from([0xc0, 0xaf])),
    ).toThrow();
  });
  it("rejects unpinned and hardlinked framework ZIPs without extraction or execution", async () => {
    const root = await temporary(),
      archive = join(root, STORE_GUI_ELECTRON.file);
    await writeFile(
      archive,
      Buffer.from("PK\u0003\u0004not-an-approved-framework"),
    );
    await expect(inspectStoreElectronArchive(archive)).rejects.toThrow(
      "STORE_GUI_ELECTRON_ARCHIVE_INVALID",
    );
    await link(archive, join(root, "alias.zip"));
    await expect(inspectStoreElectronArchive(archive)).rejects.toThrow();
  });
});
