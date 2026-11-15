import { createRequire } from "node:module";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { afterEach, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { createConfig } = require("../packaging/config.cjs");
const {
  guardPinnedInstallerStartup,
  guardPinnedUninstallerStartup,
  installPinnedNsisStartupGuard,
} = require("../packaging/nsis-startup.cjs");
const {
  assertPinnedBuilderFunction,
} = require("../packaging/builder-compat.cjs");
const {
  ownedRemovalScript,
  signedPayloadInventory,
  executedBuildGraphs,
  bundledNotices,
  verifyLicensedBuildAssets,
  verifyPackagedLicensedAssets,
} = require("../packaging/inventory.cjs");
const {
  authenticodeInvocation,
  verifySignedPe,
} = require("../packaging/authenticode.cjs");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(
    join(tmpdir(), "musicmute-package-recipe-fixture-"),
  );
  roots.push(root);
  return root;
}
it("validates against the installed v26 schema with per-user/no-elevation/ASAR integrity only", async () => {
  const root = await fixture();
  await mkdir(join(root, "app"));
  await writeFile(
    join(root, "app/packaged-resources.json"),
    JSON.stringify({
      version: 1,
      appId: "com.musicmute.local.windows",
      publisherSha256: "a".repeat(64),
    }),
  );
  const config = createConfig(root);
  const {
      validateConfiguration,
    } = require("app-builder-lib/out/util/config/config.js"),
    { DebugLogger } = require("builder-util");
  await validateConfiguration(config, new DebugLogger());
  expect(config.nsis).toMatchObject({
    oneClick: true,
    perMachine: false,
    packElevateHelper: false,
    allowElevation: false,
    deleteAppDataOnUninstall: false,
    runAfterFinish: false,
  });
  expect(config.win.requestedExecutionLevel).toBe("asInvoker");
  expect(config.publish).toBeNull();
  expect(config.forceCodeSigning).toBe(true);
  expect(config.protocols).toEqual([]);
  expect(config.electronFuses).toMatchObject({
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    onlyLoadAppFromAsar: true,
    enableEmbeddedAsarIntegrityValidation: true,
  });
  expect(config.win.signExts).toContain("!musicmute-native.exe");
  expect(config.win.signtoolOptions.signingHashAlgorithms).toEqual(["sha256"]);
});
it("generates only exact owned-file deletes and nonrecursive empty-directory cleanup", async () => {
  const root = await fixture();
  await mkdir(join(root, "resources"));
  await writeFile(join(root, "MusicMute Local.exe"), "synthetic exe");
  await writeFile(join(root, "resources/app.asar"), "synthetic asar");
  const entries = await signedPayloadInventory(root);
  expect(entries.map((entry: { path: string }) => entry.path)).toEqual([
    "MusicMute Local.exe",
    "resources/app.asar",
  ]);
  const script = ownedRemovalScript(
    entries.map((entry: { path: string }) => entry.path),
  );
  expect(script).toContain('Delete "$INSTDIR\\resources\\app.asar"');
  expect(script).toContain("${If} ${FileExists}");
  expect(script.replace(/^\s*;.*$/gmu, "")).not.toMatch(
    /RMDir \/r|\*|REBOOTOK|MusicMuteWorker|MusicMuteLocal\\|taskkill/iu,
  );
  for (const paths of [
    ["../foreign"],
    ["native/NUL.exe"],
    ["foreign$CMD.exe"],
    ["A.exe", "a.exe"],
    ["untrusted.exe "],
  ])
    expect(() => ownedRemovalScript(paths)).toThrow(
      "PACKAGE_INVENTORY_INVALID",
    );
});
function executedGraphFixture() {
  return [
    {
      outputs: { "dist/main/main.cjs": {} },
      inputs: Object.fromEntries(
        [
          "src/main/main.ts",
          "src/main/browser/package-trust.ts",
          "src/main/browser/installer-maintenance.ts",
          "src/main/browser/account-authority.ts",
        ].map((name) => [name, {}]),
      ),
    },
    ...[
      ["dist/preload/index.cjs", "src/preload/index.ts"],
      ["dist/renderer/app.js", "src/renderer/index.tsx"],
      ["dist/agent/browser-host.cjs", "src/agent/browser-host-cli.ts"],
      ["dist/agent/session-agent.cjs", "src/agent/session-agent.ts"],
      ["dist/agent/login-worker.cjs", "src/agent/login-worker.ts"],
      ["dist/agent/personal.cjs", "src/agent/personal.ts"],
      ["dist/agent/fleet.cjs", "src/agent/fleet.ts"],
      ["dist/agent/prepare.cjs", "src/agent/prepare.ts"],
    ].map(([name, entry]) => ({
      outputs: { [name!]: {} },
      inputs: { [entry!]: {} },
    })),
  ];
}
const buildOnlyDependencies = [
  "sprintf-js",
  "roarr",
  "global-agent",
  "@electron/get",
  "app-builder-lib",
  "dmg-builder",
  "electron-builder",
  "electron-builder-squirrel-windows",
];
it("requires every actual executed graph and dependency notices, including role-only dependencies", async () => {
  const root = await fixture();
  await mkdir(join(root, "node_modules/fixture-package"), { recursive: true });
  await writeFile(
    join(root, "node_modules/fixture-package/package.json"),
    JSON.stringify({ name: "fixture-package", version: "1.0.0" }),
  );
  const graphs = executedGraphFixture();
  graphs[7]!.inputs["node_modules/fixture-package/index.js"] = {};
  expect(executedBuildGraphs(graphs)).toHaveLength(9);
  expect(() => executedBuildGraphs(graphs.slice(1))).toThrow(
    "PACKAGE_BUILD_INVALID",
  );
  await expect(bundledNotices(root, graphs)).rejects.toThrow(
    "PACKAGE_NOTICE_MISSING",
  );
  await writeFile(
    join(root, "node_modules/fixture-package/LICENSE"),
    "Synthetic fixture permission text",
  );
  expect(await bundledNotices(root, graphs)).toContain("fixture-package@1.0.0");
});
it("denies missing, duplicated, unbound, and private inputs in each executed role graph", () => {
  for (let index = 0; index < 9; index += 1) {
    const graphs = executedGraphFixture();
    expect(() =>
      executedBuildGraphs(graphs.filter((_, at) => at !== index)),
    ).toThrow("PACKAGE_BUILD_INVALID");
    expect(() => executedBuildGraphs([...graphs, graphs[index]])).toThrow(
      "PACKAGE_BUILD_INVALID",
    );
    expect(() =>
      executedBuildGraphs(
        graphs.map((graph, at) =>
          at === index ? { ...graph, inputs: {} } : graph,
        ),
      ),
    ).toThrow("PACKAGE_EXECUTED_ENTRY_UNBOUND");
    for (const privateInput of [
      "../worker/tests/runtime.spec.ts",
      "../worker/.env.production",
      "credentials.json",
    ]) {
      const contaminated = executedGraphFixture();
      contaminated[index]!.inputs[privateInput] = {};
      expect(() => executedBuildGraphs(contaminated)).toThrow(
        "PACKAGE_PRIVATE_OR_FIXTURE_INPUT",
      );
    }
  }
});
it("denies the entire reviewed builder-only chain in every runtime graph, including nested Windows paths", () => {
  for (let index = 0; index < 9; index += 1)
    for (const dependency of buildOnlyDependencies)
      for (const input of [
        `node_modules/${dependency}/index.js`,
        `node_modules/app-builder-lib/node_modules/${dependency}/index.js`,
        `C:\\builder\\node_modules\\${dependency.replaceAll("/", "\\")}\\index.js`,
        `C:\\builder\\NODE_MODULES\\${dependency.toUpperCase().replaceAll("/", "\\")}\\index.js`,
        `node_modules/.pnpm/${dependency.replaceAll("/", "+")}@1.0.0/node_modules/${dependency}/index.js`,
      ]) {
        const graphs = executedGraphFixture();
        graphs[index]!.inputs[input] = {};
        expect(() => executedBuildGraphs(graphs)).toThrow(
          "PACKAGE_BUILD_ONLY_DEPENDENCY",
        );
      }
});
it("denies bare and subpath builder imports on input and output edges of every runtime graph", () => {
  for (let index = 0; index < 9; index += 1)
    for (const dependency of buildOnlyDependencies)
      for (const path of [
        dependency,
        `${dependency}/lib/index.js`,
        dependency.toUpperCase(),
      ])
        for (const edge of ["inputs", "outputs"] as const) {
          const graphs = executedGraphFixture();
          const record = graphs[index]![edge];
          const key = Object.keys(record)[0]!;
          record[key] = { imports: [{ path, external: true }] };
          expect(() => executedBuildGraphs(graphs)).toThrow(
            "PACKAGE_BUILD_ONLY_DEPENDENCY",
          );
        }
});
it("preserves approved runtime packages, scoped names, Electron and Node externals", () => {
  const graphs = executedGraphFixture();
  for (const graph of graphs) {
    graph.inputs["node_modules/react/index.js"] = {};
    graph.inputs["node_modules/sprintf-js-compatible-name/index.js"] = {};
    graph.inputs["node_modules/@electron/get-compatible-name/index.js"] = {};
    const output = Object.keys(graph.outputs)[0]!;
    graph.outputs[output] = {
      imports: [
        { path: "electron", external: true },
        { path: "node:fs/promises", external: true },
      ],
    };
  }
  expect(executedBuildGraphs(graphs)).toHaveLength(9);
});
it("bounds signed package graph traversal even when empty directories contain no file records", async () => {
  const root = await fixture();
  await mkdir(join(root, ...Array.from({ length: 17 }, () => "nested")), {
    recursive: true,
  });
  await expect(signedPayloadInventory(root)).rejects.toThrow(
    "PACKAGE_INVENTORY_INVALID",
  );
});
it("requires the actual Noto font/OFL, pinned Electron MIT and Google notice in staged and packaged ASAR bytes", async () => {
  const root = await fixture(),
    app = join(root, "app"),
    distribution = join(app, "dist"),
    component = resolve(import.meta.dirname, "..");
  const inputs = [
    [
      "../chrome-extension/macos/Resources/Fonts/NotoSansArabic.ttf",
      "renderer/fonts/NotoSansArabic.ttf",
    ],
    [
      "../chrome-extension/macos/Resources/licenses/noto_sans_arabic_ofl.txt",
      "licenses/noto_sans_arabic_ofl.txt",
    ],
    ["node_modules/electron/LICENSE", "licenses/electron_mit.txt"],
    ["packaging/notices/google-branding.txt", "licenses/google_branding.txt"],
  ] as const;
  for (const [source, target] of inputs) {
    await mkdir(resolve(distribution, target, ".."), { recursive: true });
    await copyFile(resolve(component, source), join(distribution, target));
  }
  expect(await verifyLicensedBuildAssets(component, distribution)).toHaveLength(
    4,
  );
  const asar = join(root, "app.asar");
  const archiveWriter = await require("@electron/asar").createPackage(
    app,
    asar,
  );
  await finished(archiveWriter, { cleanup: true });
  const inventory = await verifyPackagedLicensedAssets(asar, app);
  expect(inventory.map((entry: { path: string }) => entry.path)).toEqual(
    inputs.map(([, target]) => `dist/${target}`),
  );
  expect(
    inventory.every(
      (entry: { bytes: number; sha256: string }) =>
        entry.bytes > 0 && /^[a-f0-9]{64}$/u.test(entry.sha256),
    ),
  ).toBe(true);
  await writeFile(
    join(distribution, "licenses/noto_sans_arabic_ofl.txt"),
    "different license bytes",
  );
  await expect(
    verifyLicensedBuildAssets(component, distribution),
  ).rejects.toThrow("PACKAGE_NOTICE_MISSING");
  await expect(verifyPackagedLicensedAssets(asar, app)).rejects.toThrow(
    "PACKAGE_NOTICE_MISSING",
  );
});
it("keeps caller values out of the reviewed static PowerShell code and never changes execution policy", async () => {
  const artifact = resolve("quote-'-$-;-fixture.exe"),
    invocation = await authenticodeInvocation(
      artifact,
      "a".repeat(64),
      "installer",
      "b".repeat(64),
    );
  expect(invocation.args).toEqual([
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    expect.any(String),
  ]);
  const code = Buffer.from(invocation.args[3], "base64").toString("utf16le");
  expect(code).not.toContain(artifact);
  expect(code).not.toMatch(
    /Set-ExecutionPolicy|ExecutionPolicy\s+Bypass|Invoke-Expression/iu,
  );
  expect(invocation.env.MUSICMUTE_AUDIT_ARTIFACT).toBe(artifact);
  expect(invocation.env.NODE_OPTIONS).toBeUndefined();
  expect(invocation.env.PSModulePath).toBeUndefined();
  expect(code).toContain("[MusicMuteReleaseTrust]::Fresh");
  expect(code).toContain("revocation=1");
  expect(code).toContain("flags=0x80|0x2000");
  expect(code).not.toContain("0x1000");
  expect(code.indexOf("$stream = [IO.File]::Open")).toBeLessThan(
    code.indexOf("Get-AuthenticodeSignature"),
  );
  expect(code.indexOf("$stream.Dispose()")).toBeGreaterThan(
    code.indexOf("[MusicMuteReleaseResources]::Read($item.FullName,$true)"),
  );
  if (process.platform !== "win32")
    await expect(verifySignedPe(artifact, "a".repeat(64))).rejects.toThrow(
      "WINDOWS_PACKAGE_MACHINE_REQUIRED",
    );
});
it("places scope guards before stock directory mutation while retaining default signed uninstaller generation", async () => {
  const templates = "../node_modules/app-builder-lib/templates/nsis/";
  const main = guardPinnedInstallerStartup(
    await readFile(
      new URL(`${templates}installer.nsi`, import.meta.url),
      "utf8",
    ),
  );
  const init = main.slice(main.indexOf("Function .onInit"));
  expect(init.indexOf("!insertmacro preInit")).toBeLessThan(
    init.indexOf("SetOutPath $INSTDIR"),
  );
  // The unsigned intermediate program only generates the future signed
  // uninstaller in the build directory; it must exit before host/path checks
  // or creating an installed application directory on the package machine.
  expect(
    init.indexOf('WriteUninstaller "${UNINSTALLER_OUT_FILE}"'),
  ).toBeLessThan(init.indexOf("!insertmacro preInit"));
  expect(init.indexOf("!insertmacro quitSuccess")).toBeLessThan(
    init.indexOf("SetOutPath $INSTDIR"),
  );
  expect(main).toContain('!include "musicmute-owned-uninstaller.nsh"');
  const uninstall = guardPinnedUninstallerStartup(
    await readFile(
      new URL(`${templates}uninstaller.nsh`, import.meta.url),
      "utf8",
    ),
  );
  const uninit = uninstall.slice(uninstall.indexOf("Function un.onInit"));
  expect(uninit.indexOf("!insertmacro MusicMutePathPreflight")).toBeLessThan(
    uninit.indexOf("SetOutPath $INSTDIR"),
  );
  expect(() =>
    guardPinnedInstallerStartup("unreviewed future template"),
  ).toThrow("PACKAGE_BUILDER_VERSION_MISMATCH");
  expect(() =>
    guardPinnedUninstallerStartup("unreviewed future template"),
  ).toThrow("PACKAGE_BUILDER_VERSION_MISMATCH");
});
it("installs/restores only exact pinned builder function adapters without invoking packaging/signing", async () => {
  require("electron-builder");
  const {
      NsisTarget,
    } = require("app-builder-lib/out/targets/nsis/NsisTarget.js"),
    {
      WindowsSignToolManager,
    } = require("app-builder-lib/out/codeSign/windowsSignToolManager.js");
  expect(() =>
    assertPinnedBuilderFunction(
      "doSign",
      WindowsSignToolManager.prototype.doSign,
    ),
  ).not.toThrow();
  expect(() => assertPinnedBuilderFunction("doSign", async () => {})).toThrow(
    "PACKAGE_BUILDER_VERSION_MISMATCH",
  );
  const root = await fixture();
  await mkdir(join(root, "installer"));
  const original = NsisTarget.prototype.computeFinalScript;
  const restore = await installPinnedNsisStartupGuard(root);
  try {
    expect(NsisTarget.prototype.computeFinalScript).not.toBe(original);
    expect(
      await readFile(
        join(root, "installer/musicmute-owned-uninstaller.nsh"),
        "utf8",
      ),
    ).toContain("!insertmacro MusicMutePathPreflight");
  } finally {
    restore();
  }
  expect(NsisTarget.prototype.computeFinalScript).toBe(original);
});
it("uses the pinned official NSIS override instead of the default force-kill path", async () => {
  const script = await readFile(
    new URL("../packaging/installer.nsh", import.meta.url),
    "utf8",
  );
  const pinned = await readFile(
    new URL(
      "../node_modules/app-builder-lib/templates/nsis/include/allowOnlyOneInstallerInstance.nsh",
      import.meta.url,
    ),
    "utf8",
  );
  expect(pinned).toContain("!ifmacrodef customCheckAppRunning");
  expect(script).toContain("!macro customCheckAppRunning");
  expect(script).toContain("IsWow64Process2");
  expect(script).toContain("!insertmacro GetDParameter $R0");
  expect(script).toContain("IntOp $1 $1 & 0xffff");
  expect(script).toContain("19045");
  expect(script).toContain("--installer-maintenance");
  expect(script).toContain("--installer-path-preflight");
  expect(script.slice(script.indexOf("!macro preInit"))).toContain(
    "!insertmacro MusicMutePathPreflight",
  );
  expect(script).toContain("remove-owned-files.nsh");
  const commands = script.match(/^  ExecWait .+$/gmu) ?? [];
  expect(commands).toHaveLength(4);
  for (const command of commands)
    expect(script).toContain(
      `  ClearErrors\n${command}\n  \${If} \${Errors}\n  \${OrIf} $0 != 0`,
    );
  expect(script.replace(/^\s*;.*$/gmu, "")).not.toMatch(
    /taskkill|Stop-Process|RMDir \/r|HKLM|SetShellVarContext all/iu,
  );
});
