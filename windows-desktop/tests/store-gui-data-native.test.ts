import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORE_PRODUCTS } from "../src/shared/store-contracts.js";
import { REQUIRED_STORE_GUI_RESOURCES } from "../src/main/browser/store-resource-index.js";
import type { StoreNativeAuthority as StoreAuthority } from "../src/main/browser/store-native.js";

// These are isolated native/OS receiving fixtures, not installed Store proof.
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  stat: vi.fn(),
  request: vi.fn(),
  create: vi.fn(),
  close: vi.fn(),
  issuerConfirm: vi.fn(),
  issuerClose: vi.fn(),
  creatorRegister: vi.fn(),
  creatorClose: vi.fn(),
  creatorBindBrowser: vi.fn(),
}));
vi.mock("../src/main/browser/store-gui-creator.js", () => ({
  registerStoreGuiCreator: mocks.creatorRegister,
}));
vi.mock("../src/main/browser/store-gui-issuer.js", () => ({
  StoreGuiBootstrapIssuer: {
    open: async () => ({
      bindSpawnedProcess: (pid: number) => {
        if (pid !== helperPid) throw new Error("STORE_GUI_ISSUER_DENIED");
        return "c".repeat(64);
      },
      confirmBootHelper: mocks.issuerConfirm,
      close: mocks.issuerClose,
    }),
  },
}));
vi.mock("node:fs/promises", () => ({
  readFile: mocks.read,
  lstat: mocks.stat,
}));
vi.mock(
  "../../worker/src/platform/windows/consumer-native-transport.js",
  () => ({ createStoreConsumerNativeTransport: mocks.create }),
);
const product = STORE_PRODUCTS.gui;
const fullName = `${product.identityName}_0.1.0.2_x64__${product.publisherId}`;
const installed = `C:\\Program Files\\WindowsApps\\${fullName}`;
const resources = win32.join(installed, "app", "resources");
const appPath = win32.join(resources, "app.asar");
vi.mock("electron", () => ({
  app: { isPackaged: true, getAppPath: () => appPath },
}));
const names = [
  "platform",
  "arch",
  "execPath",
  "resourcesPath",
  "windowsStore",
] as const;
const descriptors = new Map(
  names.map((name) => [name, Object.getOwnPropertyDescriptor(process, name)]),
);
const helperPid = process.pid + 1;
const helperBirth = "1337133713371337";
const sid = "S-1-5-21-1-2-3-1001";
const logonSid = "S-1-5-5-1-42";
let privateResult: unknown;
let identityOverride: Record<string, unknown>;
let files: Map<string, Buffer>;
const electronVersion = Object.getOwnPropertyDescriptor(
  process.versions,
  "electron",
);
function hash(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

beforeEach(() => {
  // Explicitly model Electron as well as its mocked app module. This remains
  // a synthetic receiving fixture, never an installed GUI/Store authority.
  Object.defineProperty(process.versions, "electron", {
    configurable: true,
    value: "44.7.0",
  });
  vi.resetModules();
  for (const mock of Object.values(mocks)) mock.mockReset();
  for (const [name, value] of Object.entries({
    platform: "win32",
    arch: "x64",
    execPath: win32.join(installed, "app", "MusicMute Local.exe"),
    resourcesPath: resources,
    windowsStore: true,
  }))
    Object.defineProperty(process, name, { configurable: true, value });
  privateResult = { authorized: true, namespace: "unvirtualized-v1" };
  identityOverride = {};
  files = new Map();
  const entries = REQUIRED_STORE_GUI_RESOURCES.map((name) => {
    const [placement, path] = name.split(":") as ["app" | "resources", string];
    const value = Buffer.from(`protected fixture ${path}`);
    files.set(
      win32.join(
        installed,
        "app",
        ...(placement === "resources" ? ["resources"] : []),
        ...path.split("/"),
      ),
      value,
    );
    return { placement, path, bytes: value.length, sha256: hash(value) };
  });
  const seal = Buffer.from(
    JSON.stringify({
      version: 2,
      authority: {
        kind: "microsoft-store",
        role: "gui",
        identity: {
          identityName: product.identityName,
          publisher: product.publisher,
          publisherId: product.publisherId,
          familyName: product.familyName,
          storeId: product.storeId,
        },
        packageVersion: "0.1.0.0",
        protocolAbi: 1,
      },
      appVersion: "0.1.0",
      buildNumber: 1,
      entries,
    }),
  );
  files.set(win32.join(appPath, "packaged-resources.json"), seal);
  mocks.stat.mockImplementation(async (path: string) => {
    const bytes = files.get(path);
    if (!bytes) throw new Error("MISSING_FIXTURE_RESOURCE");
    return {
      isFile: () => true,
      isSymbolicLink: () => false,
      size: bytes.length,
      nlink: 2,
    };
  });
  mocks.read.mockImplementation(async (path: string) => {
    const bytes = files.get(path);
    if (!bytes) throw new Error("MISSING_FIXTURE_RESOURCE");
    return bytes;
  });
  mocks.close.mockResolvedValue(undefined);
  mocks.issuerConfirm.mockResolvedValue(undefined);
  mocks.issuerClose.mockResolvedValue(undefined);
  mocks.creatorClose.mockResolvedValue(undefined);
  mocks.creatorRegister.mockResolvedValue({
    close: mocks.creatorClose,
    bindBrowserAttachment: mocks.creatorBindBrowser,
  });
  mocks.create.mockResolvedValue({
    request: mocks.request,
    close: mocks.close,
    spawnedProcessId: helperPid,
  });
  mocks.request.mockImplementation(
    async (operation: string, args: Record<string, unknown>) => {
      if (operation === "store_boot")
        return {
          version: 1,
          package: {
            identityName: product.identityName,
            publisher: product.publisher,
            publisherId: product.publisherId,
            familyName: product.familyName,
            fullName,
            packageVersion: "0.1.0.2",
            architecture: "x64",
            signatureKind: 3,
            healthy: true,
            current: true,
            installedLocation: installed,
          },
          helper: {
            sid,
            session_id: 1,
            pid: helperPid,
            creation_time: helperBirth,
          },
          parent: {
            sid,
            session_id: 1,
            pid: process.pid,
            creation_time: "1337133713371000",
          },
          logon_sid: logonSid,
        };
      if (operation === "store_package_lock")
        return {
          token: "a".repeat(64),
          path: win32.join(installed, ...(args.path as string).split("/")),
          full_name: fullName,
          bytes: args.bytes,
          sha256: args.sha256,
        };
      if (operation === "store_package_release") return { released: true };
      if (operation === "store_private_boot") return privateResult;
      if (operation === "identity")
        return {
          sid,
          session_id: 1,
          pid: helperPid,
          creation_time: helperBirth,
          logon_sid: logonSid,
          native_arch: "x64",
          process_arch: "x64",
          os_major: 10,
          os_build: 19045,
          local_app_data: "C:\\Users\\fixture\\AppData\\Local",
          ...identityOverride,
        };
      if (operation === "vault_get") return null;
      throw new Error("UNEXPECTED_FIXTURE_OPERATION");
    },
  );
});
afterEach(() => {
  if (electronVersion)
    Object.defineProperty(process.versions, "electron", electronVersion);
  else Reflect.deleteProperty(process.versions, "electron");
  for (const name of names) {
    const descriptor = descriptors.get(name);
    if (descriptor) Object.defineProperty(process, name, descriptor);
    else Reflect.deleteProperty(process, name);
  }
  vi.resetModules();
});

describe("closed Store GUI data bootstrap", () => {
  it("recovers a lost code-close ACK only through the same positively retired helper", async () => {
    const { StoreNativeAuthority } =
      await import("../src/main/browser/store-native.js");
    const authority = await StoreNativeAuthority.open();
    await authority.openGuiDataNative();
    const handle = mocks.request.getMockImplementation()!,
      worker = STORE_PRODUCTS.worker,
      workerFullName = `${worker.identityName}_${worker.packageVersion}_x64__${worker.publisherId}`;
    mocks.request.mockImplementation(
      async (operation: string, args: Record<string, unknown>) => {
        if (operation === "store_worker_code_open")
          return {
            version: 1,
            package: {
              identityName: worker.identityName,
              publisher: worker.publisher,
              publisherId: worker.publisherId,
              familyName: worker.familyName,
              fullName: workerFullName,
              packageVersion: worker.packageVersion,
              architecture: "x64",
              signatureKind: 3,
              healthy: true,
              current: true,
              installedLocation: `C:\\Program Files\\WindowsApps\\${workerFullName}`,
            },
            inventory_sha256: "d".repeat(64),
            manifest: {
              path: "worker/release-manifest.json",
              bytes: 128,
              sha256: "e".repeat(64),
            },
          };
        if (operation === "store_worker_code_close")
          throw Error("ORIGINAL_CODE_CLOSE_ACK_LOST");
        return handle(operation, args);
      },
    );
    const code = await authority.openWorkerCode(),
      original = code.close();
    await expect(original).rejects.toThrow("STORE_AUTHORITY_DENIED");
    expect(mocks.close).toHaveBeenCalledOnce();
    await expect(code.revalidate()).rejects.toThrow("STORE_AUTHORITY_DENIED");
    await Promise.all([code.recoverClose(), code.recoverClose()]);
    await expect(code.close()).rejects.toThrow("STORE_AUTHORITY_DENIED");
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(
      mocks.request.mock.calls.filter(
        ([operation]) => operation === "store_worker_code_close",
      ),
    ).toHaveLength(1);
    expect(
      mocks.request.mock.calls.filter(
        ([operation]) => operation === "store_worker_code_open",
      ),
    ).toHaveLength(1);
  });
  it("denies plain Node despite a mocked Electron module before native or resource IO", async () => {
    Reflect.deleteProperty(process.versions, "electron");
    const { StoreNativeAuthority } =
      await import("../src/main/browser/store-native.js");
    await expect(StoreNativeAuthority.open()).rejects.toThrow(
      "STORE_AUTHORITY_DENIED",
    );
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("retains a separate frozen native browser proof only after the exact creator lease binds it", async () => {
    const { StoreNativeAuthority } =
      await import("../src/main/browser/store-native.js");
    const authority = await StoreNativeAuthority.open();
    await authority.openGuiDataNative();
    expect(() => authority.browserCreatorProof()).toThrow(
      "STORE_AUTHORITY_DENIED",
    );
    const peer = (pid: number, creationTime: string) => ({
      sid,
      session_id: 1,
      pid,
      creation_time: creationTime,
    });
    mocks.request.mockResolvedValue({
      version: 1,
      accepted: true,
      host: peer(process.pid + 2, "1337133713371222"),
      gui: peer(process.pid, "1337133713371000"),
      chrome: peer(process.pid + 3, "1337133713370999"),
      origin: "chrome-extension://acmgefmmndomcpdlgnafkjbgobinllep/",
      package_full_name: fullName,
    });
    const dto = await authority.browserAttach({
      hostPid: process.pid + 2,
      nonce: "d".repeat(64),
      origin: "chrome-extension://acmgefmmndomcpdlgnafkjbgobinllep/",
    });
    const proof = authority.browserCreatorProof();
    expect(proof).toEqual(dto);
    expect(proof).not.toBe(dto);
    for (const key of ["host", "gui", "chrome"] as const) {
      expect(proof[key]).not.toBe(dto[key]);
      expect(Object.isFrozen(proof[key])).toBe(true);
    }
    expect(mocks.creatorBindBrowser).toHaveBeenCalledExactlyOnceWith(authority);
    await authority.close();
    expect(() => authority.browserCreatorProof()).toThrow(
      "STORE_AUTHORITY_DENIED",
    );
  });
  it("preserves only the actual idle-listener timeout after closing its authority", async () => {
    const { StoreNativeAuthority } =
      await import("../src/main/browser/store-native.js");
    const { ConsumerNativeError } =
      await import("../../worker/src/platform/windows/consumer-native.js");
    const authority = await StoreNativeAuthority.open();
    await authority.openGuiDataNative();
    const timeout = new ConsumerNativeError("TIMEOUT");
    mocks.request.mockRejectedValue(timeout);
    await expect(
      authority.accountOperation("store_account_pipe_accept", {
        channel: "a".repeat(64),
        nonce: "b".repeat(64),
        timeout_ms: 100,
      }),
    ).rejects.toBe(timeout);
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(() => authority.creatorProof()).toThrow("STORE_AUTHORITY_DENIED");
  });
  it("keeps cache/Library recovery behind the existing exact native cache mutex", async () => {
    const { StoreNativeAuthority } =
      await import("../src/main/browser/store-native.js");
    const authority = await StoreNativeAuthority.open();
    const native = await authority.openGuiDataNative();
    await expect(native.recoverCacheDeletions()).rejects.toThrow("PEER_DENIED");
    const handle = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(
      async (operation: string, args: Record<string, unknown>) => {
        if (operation === "acquire_mutex")
          return {
            acquired: true,
            scope: "cache",
            nonce: "e".repeat(64),
            abandoned: false,
            identity: {
              sid,
              session_id: 1,
              pid: helperPid,
              creation_time: helperBirth,
            },
          };
        if (operation === "cache_delete_recover")
          return { completed: 0, pending: 0 };
        if (operation === "library_tree_cleanup_list") return { entries: [] };
        return handle(operation, args);
      },
    );
    await native.acquireMutex("cache");
    await expect(native.recoverCacheDeletions()).resolves.toEqual({
      completed: 0,
      pending: 0,
    });
    await expect(native.listLibraryCleanups()).resolves.toEqual([]);
    expect(mocks.request).toHaveBeenLastCalledWith(
      "library_tree_cleanup_list",
      { cache_nonce: "e".repeat(64) },
      35000,
    );
    await expect(
      native.removeRuntimeRepairBackup("a".repeat(64), "b".repeat(64)),
    ).rejects.toThrow("PEER_DENIED");
    await authority.close();
  });
  it("retires the private data port when a held resource cannot be revalidated", async () => {
    const { StoreNativeAuthority } =
      await import("../src/main/browser/store-native.js");
    const authority = await StoreNativeAuthority.open();
    const native = await authority.openGuiDataNative();
    const handle = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(
      async (operation: string, args: Record<string, unknown>) =>
        operation === "store_package_release"
          ? { released: false }
          : handle(operation, args),
    );
    const entry = authority.resourceIndex.entries.find(
      (value) => value.path === "desktop-build.json",
    )!;
    await expect(
      authority.readResource(
        "app/resources/desktop-build.json",
        { bytes: entry.bytes, sha256: entry.sha256 },
        4096,
      ),
    ).rejects.toThrow("STORE_AUTHORITY_DENIED");
    expect(mocks.close).toHaveBeenCalledOnce();
    await expect(native.identity()).rejects.toThrow("HELPER_UNAVAILABLE");
  });
  it("publishes Store host authority only from the actual packaged host factory", async () => {
    const handle = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(
      async (operation: string, args: Record<string, unknown>) => {
        if (operation === "ensure_private_directory")
          return { path: "C:\\Users\\fixture\\AppData\\Local\\MusicMuteLocal" };
        if (operation === "vault_put") return { version: 1, stored: true };
        return handle(operation, args);
      },
    );
    const { openWindowsHost } = await import("../src/main/host-context.js");
    const context = await openWindowsHost(resources, "0.1.0", 1);
    const { StoreNativeAuthority } =
      await import("../src/main/browser/store-native.js");
    expect(context.storeAuthority).toBeInstanceOf(StoreNativeAuthority);
    expect(context.identity.pid).toBe(helperPid);
    await context.close();
    expect(mocks.close).toHaveBeenCalledOnce();
    await expect(context.storeAuthority!.inspectWorker()).rejects.toThrow(
      "STORE_AUTHORITY_DENIED",
    );
  });
  it("does not inspect Worker or mutate Chrome registration before private data admission", async () => {
    const { StoreNativeAuthority } =
      await import("../src/main/browser/store-native.js");
    const authority = await StoreNativeAuthority.open();
    await expect(authority.inspectWorker()).rejects.toThrow(
      "STORE_AUTHORITY_DENIED",
    );
    await expect(authority.browserRegistration("register")).rejects.toThrow(
      "STORE_AUTHORITY_DENIED",
    );
    expect(
      mocks.request.mock.calls.some((call) =>
        ["store_worker_discover", "store_browser_registration"].includes(
          call[0],
        ),
      ),
    ).toBe(false);
    await authority.close();
  });
  it("inspects Worker absence through its fixed native request without a caller path", async () => {
    const { StoreNativeAuthority } =
      await import("../src/main/browser/store-native.js");
    const authority = await StoreNativeAuthority.open();
    await authority.openGuiDataNative();
    const handle = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation(
      async (operation: string, args: Record<string, unknown>) =>
        operation === "store_worker_discover"
          ? { version: 1, state: "missing" }
          : handle(operation, args),
    );
    await expect(authority.inspectWorker()).resolves.toEqual({
      version: 1,
      state: "missing",
    });
    expect(mocks.request).toHaveBeenLastCalledWith("store_worker_discover", {});
    await expect(
      Reflect.apply(authority.inspectWorker, authority, [
        { packagePath: "C:\\mutable\\Worker" },
      ]),
    ).rejects.toThrow("STORE_AUTHORITY_DENIED");
    await authority.close();
  });
  it("closes the live helper instead of treating a bad Worker response as missing", async () => {
    const { StoreNativeAuthority } =
      await import("../src/main/browser/store-native.js");
    const authority = await StoreNativeAuthority.open();
    await authority.openGuiDataNative();
    mocks.request.mockResolvedValue({
      version: 1,
      state: "missing",
      queryFailed: true,
    });
    await expect(authority.inspectWorker()).rejects.toThrow(
      "STORE_AUTHORITY_DENIED",
    );
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it("binds Store Chrome registration to the live native GUI package", async () => {
    const { StoreNativeAuthority } =
      await import("../src/main/browser/store-native.js");
    const authority = await StoreNativeAuthority.open();
    await authority.openGuiDataNative();
    mocks.request.mockResolvedValue({
      version: 1,
      registered: true,
      state: "registered",
      package_full_name: fullName,
      manifest_sha256: "b".repeat(64),
      launch_target: "current-package",
      alias_required: false,
      ordinary_registry_verified: true,
      extension_id: "acmgefmmndomcpdlgnafkjbgobinllep",
    });
    const { registerBrowserIntegration, verifyBrowserIntegration } =
      await import("../src/main/browser/registration.js");
    // Factory association is separately covered above. This service fixture
    // supplies the real privately branded class, never a fabricated adapter.
    const host = { storeAuthority: authority } as never;
    expect(await registerBrowserIntegration(host, resources)).toBe(true);
    expect(await verifyBrowserIntegration(host, resources)).toBe(true);
    expect(mocks.request).toHaveBeenLastCalledWith(
      "store_browser_registration",
      { intent: "inspect" },
    );
    await authority.close();
  });
  it("rejects a different browser host in an otherwise bound attachment receipt", async () => {
    const { StoreNativeAuthority } =
      await import("../src/main/browser/store-native.js");
    const authority = await StoreNativeAuthority.open();
    await authority.openGuiDataNative();
    const peer = (pid: number, creationTime: string) => ({
      sid,
      session_id: 1,
      pid,
      creation_time: creationTime,
    });
    mocks.request.mockResolvedValue({
      version: 1,
      accepted: true,
      host: peer(process.pid + 4, "1337133713371222"),
      gui: peer(process.pid, "1337133713371000"),
      chrome: peer(process.pid + 3, "1337133713370999"),
      origin: "chrome-extension://acmgefmmndomcpdlgnafkjbgobinllep/",
      package_full_name: fullName,
    });
    await expect(
      authority.browserAttach({
        hostPid: process.pid + 2,
        nonce: "d".repeat(64),
        origin: "chrome-extension://acmgefmmndomcpdlgnafkjbgobinllep/",
      }),
    ).rejects.toThrow("STORE_AUTHORITY_DENIED");
    expect(mocks.request).toHaveBeenLastCalledWith("store_browser_attach", {
      host_pid: process.pid + 2,
      nonce: "d".repeat(64),
      origin: "chrome-extension://acmgefmmndomcpdlgnafkjbgobinllep/",
    });
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it("admits existing data primitives after the fixed native namespace check and binds actual helper identity", async () => {
    const { StoreNativeAuthority } =
      await import("../src/main/browser/store-native.js");
    const authority = await StoreNativeAuthority.open();
    const helper = files.get(
      win32.join(resources, "native", "musicmute-native.exe"),
    )!;
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith(
      win32.join(resources, "native", "musicmute-native.exe"),
      hash(helper),
    );
    const native = await authority.openGuiDataNative();
    expect(mocks.request).toHaveBeenCalledWith(
      "store_boot",
      {
        role: "gui",
        parent_role: "gui-application",
        issuer_nonce: "c".repeat(64),
      },
      35000,
    );
    expect(mocks.issuerConfirm).toHaveBeenCalledWith(helperPid, helperBirth);
    expect(mocks.request).toHaveBeenCalledWith("store_private_boot", {});
    expect((await native.identity()).pid).toBe(helperPid);
    await expect(native.vaultRead("account", "credential")).resolves.toBeNull();
    await expect(native.registerStartup("a".repeat(64))).rejects.toThrow(
      "LAUNCH_VERIFICATION_REQUIRED",
    );
    expect(
      mocks.request.mock.calls.some((call) => call[0] === "startup_register"),
    ).toBe(false);
    await expect(authority.openGuiDataNative()).rejects.toThrow(
      "STORE_AUTHORITY_DENIED",
    );
    await native.close();
    expect(mocks.close).toHaveBeenCalledOnce();
    await expect(native.identity()).rejects.toThrow("HELPER_UNAVAILABLE");
  });
  it.each([
    { authorized: false, namespace: "unvirtualized-v1" },
    { authorized: true, namespace: "packaged-classic-v1" },
    { authorized: true, namespace: "unvirtualized-v1", allowUnsigned: true },
    null,
  ])(
    "denies an incomplete or wrong namespace receipt %j and retires the helper",
    async (result) => {
      privateResult = result;
      const { StoreNativeAuthority } =
        await import("../src/main/browser/store-native.js");
      const authority = await StoreNativeAuthority.open();
      await expect(authority.openGuiDataNative()).rejects.toThrow(
        "STORE_AUTHORITY_DENIED",
      );
      expect(mocks.close).toHaveBeenCalledOnce();
      expect(
        mocks.request.mock.calls.some((call) => call[0] === "identity"),
      ).toBe(false);
    },
  );
  it.each([
    { sid: "S-1-5-21-1-2-3-1002" },
    { session_id: 2 },
    { pid: helperPid + 1 },
    { creation_time: "1337133713371338" },
    { logon_sid: "S-1-5-5-1-43" },
  ])(
    "denies a changed helper identity %j after admission",
    async (override) => {
      identityOverride = override;
      const { StoreNativeAuthority } =
        await import("../src/main/browser/store-native.js");
      const authority = await StoreNativeAuthority.open();
      await expect(authority.openGuiDataNative()).rejects.toThrow(
        "STORE_AUTHORITY_DENIED",
      );
      expect(mocks.close).toHaveBeenCalledOnce();
    },
  );
  it("denies selected paths/receipts, a forged instance and a closed authority before data bootstrap", async () => {
    const { StoreNativeAuthority } =
      await import("../src/main/browser/store-native.js");
    const authority = await StoreNativeAuthority.open();
    await expect(
      Reflect.apply(authority.openGuiDataNative, authority, [
        { helperPath: "C:\\fixture\\fake.exe" },
      ]),
    ).rejects.toThrow("STORE_AUTHORITY_DENIED");
    const forged = Object.create(
      StoreNativeAuthority.prototype,
    ) as StoreAuthority;
    await expect(forged.openGuiDataNative()).rejects.toThrow();
    await authority.close();
    await expect(authority.openGuiDataNative()).rejects.toThrow(
      "STORE_AUTHORITY_DENIED",
    );
    expect(
      mocks.request.mock.calls.some((call) => call[0] === "store_private_boot"),
    ).toBe(false);
  });
});
