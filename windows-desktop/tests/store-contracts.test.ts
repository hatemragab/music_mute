import { describe, expect, it } from "vitest";
import {
  STORE_PRODUCTS,
  STORE_ROLE_OWNERS,
  assertStoreHost,
  classifyStoreCode,
  compareStorePackageVersions,
  evaluateStorePackagePair,
  parseStoreBuildNumber,
  parseStoreCodeReference,
  parseStoreCodeReferenceJson,
  parseStoreInstalledPackage,
  parseStoreInstalledPackageJson,
  parseStorePackageIdentity,
  parseStorePackageIdentityJson,
  parseStorePackageVersion,
  planStoreLifecycle,
  type StoreProductRole,
} from "../src/shared/store-contracts.js";

function installed(role: StoreProductRole, revision = 0) {
  const product = STORE_PRODUCTS[role];
  const packageVersion = `${product.appVersion}.${revision}`;
  const fullName = `${product.identityName}_${packageVersion}_x64__${product.publisherId}`;
  return {
    identityName: product.identityName,
    publisher: product.publisher,
    publisherId: product.publisherId,
    familyName: product.familyName,
    fullName,
    packageVersion,
    architecture: "x64",
    signatureKind: 3,
    healthy: true,
    current: true,
    installedLocation: `C:\\Program Files\\WindowsApps\\${fullName}`,
  };
}
function identity(role: StoreProductRole) {
  const p = STORE_PRODUCTS[role];
  return {
    identityName: p.identityName,
    publisher: p.publisher,
    publisherId: p.publisherId,
    familyName: p.familyName,
    storeId: p.storeId,
  };
}

describe("actual Store product identities", () => {
  it.each(["gui", "worker"] as const)(
    "accepts only the recorded %s product",
    (role) => {
      expect(parseStorePackageIdentity(role, identity(role))).toEqual(
        identity(role),
      );
      expect(
        parseStorePackageIdentityJson(role, JSON.stringify(identity(role))),
      ).toEqual(identity(role));
    },
  );
  it.each([
    "identityName",
    "publisher",
    "publisherId",
    "familyName",
    "storeId",
  ] as const)("rejects a foreign %s", (field) => {
    expect(() =>
      parseStorePackageIdentity("gui", {
        ...identity("gui"),
        [field]: "foreign",
      }),
    ).toThrow("STORE_CONTRACT_INVALID");
  });
  it("rejects role swapping, unknown authority fields, inherited fields and getters", () => {
    expect(() =>
      parseStorePackageIdentity("gui", identity("worker")),
    ).toThrow();
    expect(() =>
      parseStorePackageIdentity("gui", { ...identity("gui"), approved: true }),
    ).toThrow();
    expect(() =>
      parseStorePackageIdentity("gui", Object.create(identity("gui"))),
    ).toThrow();
    let invoked = false;
    const value = identity("gui");
    Object.defineProperty(value, "publisher", {
      enumerable: true,
      get: () => {
        invoked = true;
        return STORE_PRODUCTS.gui.publisher;
      },
    });
    expect(() => parseStorePackageIdentity("gui", value)).toThrow();
    expect(invoked).toBe(false);
  });
  it("rejects duplicate decoded fields, oversized bytes and invalid UTF-8", () => {
    const text = JSON.stringify(identity("gui"));
    const duplicate = text.replace(
      '"identityName":',
      '"identityName":"foreign","\\u0069dentityName":',
    );
    expect(() => parseStorePackageIdentityJson("gui", duplicate)).toThrow();
    expect(() =>
      parseStorePackageIdentityJson("gui", " ".repeat(16385)),
    ).toThrow();
    expect(() =>
      parseStorePackageIdentityJson("gui", new Uint8Array([0xff])),
    ).toThrow();
  });
});

describe("Store four-part versions and explicit app build", () => {
  it("accepts uint16 boundaries and preserves Store-assigned installed revisions", () => {
    expect(parseStorePackageVersion("65535.0.65535.65535").parts).toEqual([
      65535, 0, 65535, 65535,
    ]);
    expect(parseStorePackageVersion("0.1.3.17").semanticVersion).toBe("0.1.3");
    expect(parseStorePackageVersion("0.1.3.0", true).text).toBe("0.1.3.0");
    expect(() => parseStorePackageVersion("0.1.3.17", true)).toThrow();
    expect(compareStorePackageVersions("0.1.3.9", "0.1.3.10")).toBe(-1);
    expect(compareStorePackageVersions("0.2.0.0", "0.1.65535.65535")).toBe(1);
    expect(compareStorePackageVersions("0.1.3.10", "0.1.3.10")).toBe(0);
  });
  it.each([
    "0.1.0",
    "01.1.0.0",
    "0.1.0.00",
    "0.1.0.65536",
    "0.1.-1.0",
    "0.1.0.0-beta",
    "0.1.0.0\n",
    "1e1.0.0.0",
    1,
    null,
  ])("rejects malformed version %j", (value) =>
    expect(() => parseStorePackageVersion(value)).toThrow(),
  );
  it.each([undefined, null, 0, -1, 1.5, 2147483648, NaN, "1"])(
    "never infers a build number from %j",
    (value) => expect(() => parseStoreBuildNumber(value)).toThrow(),
  );
  it("accepts explicitly chosen positive builds", () => {
    expect(parseStoreBuildNumber(1)).toBe(1);
    expect(parseStoreBuildNumber(2147483647)).toBe(2147483647);
  });
});

describe("production OS Store registration observations", () => {
  it("accepts each exact live registered identity and copies it immutably", () => {
    const source = installed("gui", 20);
    const parsed = parseStoreInstalledPackage("gui", source);
    source.fullName = "changed";
    expect(parsed.fullName).toContain("0.1.0.20_x64__");
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(
      parseStoreInstalledPackageJson(
        "worker",
        new TextEncoder().encode(JSON.stringify(installed("worker"))),
      ),
    ).toEqual(installed("worker"));
  });
  it.each([0, 1, 2, 4, "3", null])(
    "rejects non-Store or QA signatureKind %j",
    (signatureKind) =>
      expect(() =>
        parseStoreInstalledPackage("gui", {
          ...installed("gui"),
          signatureKind,
        }),
      ).toThrow(),
  );
  it.each([
    { architecture: "arm64" },
    { architecture: "x86" },
    { healthy: false },
    { current: false },
    { publisherId: "foreign" },
    { familyName: STORE_PRODUCTS.worker.familyName },
    {
      fullName: `${STORE_PRODUCTS.gui.identityName}_0.1.0.0_x64_resource_${STORE_PRODUCTS.gui.publisherId}`,
    },
    { packageVersion: "0.1.0.1" },
    { origin: "qa" },
  ])("rejects changed observation %j", (edit) =>
    expect(() =>
      parseStoreInstalledPackage("gui", { ...installed("gui"), ...edit }),
    ).toThrow(),
  );
  it.each([
    "C:\\evil\\..\\package",
    "\\\\server\\share\\package",
    "C:/package",
    "C:\\package:stream",
    "C:\\x\u0000\\package",
    "C:\\x\ud800\\package",
  ])("rejects unsafe installation location %j", (installedLocation) =>
    expect(() =>
      parseStoreInstalledPackage("gui", {
        ...installed("gui"),
        installedLocation,
      }),
    ).toThrow(),
  );
  it("rejects duplicated signature and unknown authority fields before trusting a payload", () => {
    const text = JSON.stringify(installed("gui")).replace(
      '"signatureKind":3',
      '"signatureKind":0,"signatureKind":3',
    );
    expect(() => parseStoreInstalledPackageJson("gui", text)).toThrow();
    expect(() =>
      parseStoreInstalledPackage("gui", {
        ...installed("gui"),
        approvedByFixture: true,
      }),
    ).toThrow();
  });
});

describe("x64 minimum host and exact GUI/Worker ABI pair", () => {
  const host = {
    platform: "win32",
    processArchitecture: "x64",
    nativeArchitecture: "x64",
    osBuild: 19045,
  };
  it("accepts Windows 10 minimum and Windows 11 x64", () => {
    expect(assertStoreHost(host)).toEqual(host);
    expect(assertStoreHost({ ...host, osBuild: 26200 }).osBuild).toBe(26200);
  });
  it.each([
    { osBuild: 19044 },
    { osBuild: 19045.5 },
    { nativeArchitecture: "arm64" },
    { processArchitecture: "ia32" },
    { platform: "darwin" },
    { osBuild: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects unsupported host %j", (edit) =>
    expect(() => assertStoreHost({ ...host, ...edit })).toThrow(),
  );
  it("accepts an independently serviced Store revision without accepting a new semantic ABI", () => {
    expect(
      evaluateStorePackagePair(installed("gui", 20), installed("worker", 7)),
    ).toMatchObject({ ready: true, protocolAbi: 1, workerMayContinue: true });
    const worker = installed("worker");
    worker.packageVersion = "0.1.4.0";
    worker.fullName = `${worker.identityName}_0.1.4.0_x64__${worker.publisherId}`;
    worker.installedLocation = `C:\\Program Files\\WindowsApps\\${worker.fullName}`;
    expect(evaluateStorePackagePair(installed("gui"), worker)).toMatchObject({
      ready: false,
      reason: "PAIR_INCOMPATIBLE",
      workerMayContinue: false,
    });
    expect(
      evaluateStorePackagePair(installed("gui"), installed("worker"), 2),
    ).toMatchObject({ ready: false, reason: "PAIR_INCOMPATIBLE" });
  });
  it("provides missing-product recovery and keeps a qualified Worker independent", () => {
    expect(evaluateStorePackagePair(null, installed("worker"))).toEqual({
      ready: false,
      reason: "GUI_MISSING",
      workerMayContinue: true,
      recover: ["gui"],
    });
    expect(evaluateStorePackagePair(installed("gui"), null)).toEqual({
      ready: false,
      reason: "WORKER_MISSING",
      workerMayContinue: false,
      recover: ["worker"],
    });
    expect(evaluateStorePackagePair(null, null)).toEqual({
      ready: false,
      reason: "BOTH_MISSING",
      workerMayContinue: false,
      recover: ["gui", "worker"],
    });
    expect(() =>
      evaluateStorePackagePair(undefined, installed("worker")),
    ).toThrow();
  });
  it("compares full versions against durable floors, including Store revisions", () => {
    expect(
      evaluateStorePackagePair(installed("gui", 2), installed("worker", 4), 1, {
        gui: "0.1.0.3",
        worker: "0.1.3.4",
      }),
    ).toMatchObject({
      ready: false,
      reason: "PACKAGE_ROLLBACK",
      workerMayContinue: true,
    });
    expect(
      evaluateStorePackagePair(installed("gui", 2), installed("worker", 3), 1, {
        gui: "0.1.0.2",
        worker: "0.1.3.4",
      }),
    ).toMatchObject({
      ready: false,
      reason: "PACKAGE_ROLLBACK",
      workerMayContinue: false,
    });
    expect(() =>
      evaluateStorePackagePair(installed("gui"), installed("worker"), 1, {
        gui: "bad",
        worker: "0.1.3.0",
      }),
    ).toThrow();
  });
});

describe("closed Store executable ownership", () => {
  it.each([
    ["gui", "MusicMute Local.exe", "desktop-main"],
    ["gui", "MusicMuteChromeHost.exe", "chrome-proxy"],
    ["gui", "resources/native/musicmute-native.exe", "gui-native-helper"],
    ["gui", "MusicMuteSession.exe", "gui-session-proxy"],
    ["gui", "resources/native/browser-host.cjs", "browser-host"],
    ["gui", "resources/app.asar", "electron"],
    ["gui", "dist/preload/index.cjs", "preload"],
    ["gui", "dist/renderer/app.js", "renderer"],
    ["worker", "MusicMuteSession.exe", "session-launcher"],
    ["worker", "MusicMuteWorker.exe", "worker-controls"],
    ["worker", "runtime/native/musicmute-native.exe", "native-helper"],
    ["worker", "runtime/node/node.exe", "node"],
    ["worker", "runtime/python/python.exe", "python"],
    [
      "worker",
      "runtime/python/Lib/site-packages/onnxruntime/capi/onnxruntime_pybind11_state.pyd",
      "python",
    ],
    ["worker", "app/engine/musicmute_engine/consumer_personal.py", "engine"],
    ["worker", "app/dist/src/cli/main.js", "worker-code"],
    ["worker", "app/node_modules/pkg/index.js", "worker-dependency"],
    ["worker", "runtime/bin/ffmpeg.exe", "media"],
    ["worker", "tools/youtube/bin/deno.exe", "acquisition"],
    [
      "worker",
      "tools/downloader/yt_dlp-2026.8.19-py3-none-any.whl",
      "acquisition",
    ],
    ...["session-agent", "login-worker", "personal", "fleet", "prepare"].map(
      (kind) => ["worker", `agent/${kind}.cjs`, kind],
    ),
  ])("classifies %s %s", (owner, path, kind) => {
    expect(classifyStoreCode(owner as StoreProductRole, path)).toBe(kind);
    expect(STORE_ROLE_OWNERS[kind as keyof typeof STORE_ROLE_OWNERS]).toBe(
      owner,
    );
  });
  it.each([
    "C:/download/node.exe",
    "personal/runtime/releases/v1/app/engine/child.py",
    "../runtime/node/node.exe",
    "runtime\\node\\node.exe",
    "runtime/python/__pycache__/a.pyc",
    "app/dist/tests/fixture.js",
    "tools/youtube/secrets.key",
    "runtime/node/node.exe:stream",
    "runtime/python/CON.py",
    "runtime/python/py.dll ",
    "resources/default_app.asar",
  ])("rejects external or unsafe executable %s", (path) =>
    expect(() => classifyStoreCode("worker", path)).toThrow(),
  );
  it("rejects wrong-package execution and requires exact sealed-file digests", () => {
    expect(() => classifyStoreCode("gui", "runtime/node/node.exe")).toThrow();
    expect(() =>
      classifyStoreCode("worker", "resources/native/musicmute-native.exe"),
    ).toThrow();
    expect(() => classifyStoreCode("gui", "MusicMuteWorker.exe")).toThrow();
    expect(() => classifyStoreCode("gui", "app/MusicMute Local.exe")).toThrow();
    expect(() =>
      classifyStoreCode("worker", "worker/MusicMuteWorker.exe"),
    ).toThrow();
    const ref = {
      owner: "worker",
      kind: "node",
      relativePath: "runtime/node/node.exe",
      bytes: 10,
      sha256: "a".repeat(64),
    };
    expect(parseStoreCodeReference(ref)).toEqual(ref);
    expect(parseStoreCodeReferenceJson(JSON.stringify(ref))).toEqual(ref);
    expect(() => parseStoreCodeReference({ ...ref, kind: "python" })).toThrow();
    expect(() =>
      parseStoreCodeReference({ ...ref, sha256: "A".repeat(64) }),
    ).toThrow();
    expect(() =>
      parseStoreCodeReference({ ...ref, source: "download" }),
    ).toThrow();
  });
});

describe("independent package removal and guarded data retention", () => {
  const state = { guiInstalled: true, workerInstalled: true, loggedIn: true };
  it("preserves a logged-in Worker after GUI removal and account sign-out", () => {
    expect(planStoreLifecycle("remove-gui", state)).toMatchObject({
      removePackages: ["gui"],
      workerMayContinue: true,
      retireWorkerTree: false,
      deleteExternalData: false,
    });
    expect(planStoreLifecycle("sign-out", state)).toMatchObject({
      clearGuiAccountSession: true,
      workerMayContinue: true,
      retireWorkerTree: false,
      retireGuiOwnedPersonalWork: false,
    });
    expect(planStoreLifecycle("update-gui", state).workerMayContinue).toBe(
      true,
    );
  });
  it.each([
    "remove-worker",
    "update-worker",
    "repair-worker",
    "reset-worker",
    "logoff",
  ])("retires owned Worker work for %s", (action) =>
    expect(planStoreLifecycle(action, state)).toMatchObject({
      retireWorkerTree: true,
      workerMayContinue: false,
      deleteExternalData: false,
    }),
  );
  it("keeps external retention conditional on actual namespace proof after both uninstalls", () => {
    expect(planStoreLifecycle("remove-both", state)).toMatchObject({
      removePackages: ["gui", "worker"],
      externalRetention: "requires-proven-nonvirtualized-root",
      deleteExternalData: false,
      executableUpdates: "store-only",
    });
    expect(
      planStoreLifecycle("remove-both", { ...state, guiInstalled: false })
        .removePackages,
    ).toEqual(["worker"]);
    expect(
      planStoreLifecycle("close-gui", { ...state, loggedIn: false })
        .workerMayContinue,
    ).toBe(false);
  });
  it("rejects caller-supplied deletion authority and malformed lifecycle state", () => {
    expect(() => planStoreLifecycle("delete-data", state)).toThrow();
    expect(() =>
      planStoreLifecycle("remove-gui", { ...state, deleteData: true }),
    ).toThrow();
    expect(() =>
      planStoreLifecycle("remove-gui", { ...state, workerInstalled: "yes" }),
    ).toThrow();
  });
});
