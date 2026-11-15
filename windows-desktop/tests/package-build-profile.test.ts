import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ConsumerNativeChildTransport,
  parseStoreBootstrapDiagnosticLine,
} from "../../worker/src/platform/windows/consumer-native-transport.js";

type Receiver = typeof import("../src/shared/store-contracts.js") &
  typeof import("../src/shared/package-build-profile.js") &
  typeof import("../src/main/browser/store-resource-index.js") &
  typeof import("../src/main/desktop-package-identity.js") &
  typeof import("../src/main/browser/store-bootstrap-diagnostics.js");
const require = createRequire(import.meta.url);
let temporary: string;
const receivers = new Map<string, Receiver>();
const outputs = new Map<string, string>();

beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "musicmute-package-profile-"));
  for (const profile of ["default", "store-v1", "local-test-v1", "foreign"]) {
    const output = join(temporary, `${profile}.cjs`);
    const compiled = await build({
      absWorkingDir: resolve(import.meta.dirname, ".."),
      stdin: {
        contents: [
          'export * from "./src/shared/store-contracts.ts";',
          'export * from "./src/shared/package-build-profile.ts";',
          'export * from "./src/main/browser/store-resource-index.ts";',
          'export * from "./src/main/desktop-package-identity.ts";',
          'export * from "./src/main/browser/store-bootstrap-diagnostics.ts";',
        ].join("\n"),
        resolveDir: resolve(import.meta.dirname, ".."),
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "cjs",
      platform: "node",
      target: "node24",
      ...(profile === "default"
        ? {}
        : {
            define: {
              __MUSICMUTE_PACKAGE_AUTHORITY_PROFILE__: JSON.stringify(profile),
            },
          }),
    });
    await writeFile(output, compiled.outputFiles[0]!.contents);
    outputs.set(profile, output);
    if (profile !== "foreign") receivers.set(profile, require(output));
  }
}, 15_000);
afterAll(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

function receiver(profile: string): Receiver {
  const value = receivers.get(profile);
  if (!value) throw new Error("PROFILE_FIXTURE_MISSING");
  return value;
}
function installed(profile: string, role: "gui" | "worker") {
  const api = receiver(profile);
  const wanted = api.STORE_PRODUCTS[role];
  const fullName = `${wanted.identityName}_${wanted.packageVersion}_x64__${wanted.publisherId}`;
  return {
    identityName: wanted.identityName,
    publisher: wanted.publisher,
    publisherId: wanted.publisherId,
    familyName: wanted.familyName,
    fullName,
    packageVersion: wanted.packageVersion,
    architecture: "x64",
    signatureKind: api.PACKAGE_REQUIRED_SIGNATURE_KIND,
    healthy: true,
    current: true,
    installedLocation: `C:\\Program Files\\WindowsApps\\${fullName}`,
  };
}
function seal(profile: string) {
  const api = receiver(profile);
  const product = api.STORE_PRODUCTS.gui;
  return {
    version: 2,
    authority: {
      kind: api.PACKAGE_AUTHORITY_KIND,
      role: "gui",
      identity: {
        identityName: product.identityName,
        publisher: product.publisher,
        publisherId: product.publisherId,
        familyName: product.familyName,
        storeId: product.storeId,
      },
      packageVersion: product.packageVersion,
      protocolAbi: 1,
    },
    appVersion: product.appVersion,
    buildNumber: 1,
    entries: api.REQUIRED_STORE_GUI_RESOURCES.map((name) => {
      const split = name.indexOf(":");
      return {
        placement: name.slice(0, split),
        path: name.slice(split + 1),
        bytes: 32,
        sha256: "1".repeat(64),
      };
    }),
  };
}

describe("immutable compiled package authority profiles", () => {
  it.each(["default", "store-v1"])(
    "%s retains the actual production identities and Store-only signature",
    (profile) => {
      const api = receiver(profile);
      expect(api.PACKAGE_AUTHORITY_PROFILE).toBe("store-v1");
      expect(api.PACKAGE_AUTHORITY_KIND).toBe("microsoft-store");
      expect(api.PACKAGE_REQUIRED_SIGNATURE_KIND).toBe(3);
      expect(api.STORE_PRODUCTS.gui.identityName).toBe(
        "27120VCHATSDK.MusicMute",
      );
      expect(api.STORE_PRODUCTS.worker.identityName).toBe(
        "27120VCHATSDK.MusicMuteWorker",
      );
      expect(api.STORE_PRODUCTS.gui.displayName).toBe("MusicMute");
      expect(api.STORE_PRODUCTS.worker.displayName).toBe("MusicMute Worker");
      expect(api.STORE_PUBLISHER).toBe(
        "CN=8A81D011-D5B0-414F-B3F7-A768A6B8C95E",
      );
      expect(api.STORE_PUBLISHER_ID).toBe("5q1esjnkz8cve");
      expect(api.PACKAGE_DATA_ROOT_NAMES).toEqual({
        personal: "MusicMuteLocal",
        fleet: "MusicMuteWorker",
      });
    },
  );
  it("uses distinct development identities, authority marker and user-data roots", () => {
    const api = receiver("local-test-v1");
    expect(api.PACKAGE_AUTHORITY_KIND).toBe("local-developer-test");
    expect(api.PACKAGE_REQUIRED_SIGNATURE_KIND).toBe(1);
    expect(api.STORE_PRODUCTS.gui.identityName).toBe("MusicMute.Development");
    expect(api.STORE_PRODUCTS.worker.identityName).toBe(
      "MusicMute.WorkerDevelopment",
    );
    expect(api.STORE_PRODUCTS.gui.displayName).toBe("MusicMute Development");
    expect(api.STORE_PRODUCTS.worker.displayName).toBe(
      "MusicMute Worker Development",
    );
    expect(api.STORE_PUBLISHER).toBe("CN=MusicMute Z440 Development");
    expect(api.STORE_PUBLISHER_ID).toBe("kthggmwhkdz4t");
    expect(api.PACKAGE_DATA_ROOT_NAMES).toEqual({
      personal: "MusicMuteLocalDevelopment",
      fleet: "MusicMuteWorkerDevelopment",
    });
    expect(Object.isFrozen(api.PACKAGE_DATA_ROOT_NAMES)).toBe(true);
  });
  it.each(["gui", "worker"] as const)(
    "mutually rejects the other %s namespace and every wrong signature kind",
    (role) => {
      for (const profile of ["store-v1", "local-test-v1"]) {
        const api = receiver(profile);
        const row = installed(profile, role);
        expect(api.parseStoreInstalledPackage(role, row)).toEqual(row);
        for (const signatureKind of [0, 1, 2, 3, 4, "1", "3", null]) {
          if (signatureKind === api.PACKAGE_REQUIRED_SIGNATURE_KIND) continue;
          expect(() =>
            api.parseStoreInstalledPackage(role, { ...row, signatureKind }),
          ).toThrow("STORE_CONTRACT_INVALID");
        }
        const other = profile === "store-v1" ? "local-test-v1" : "store-v1";
        expect(() =>
          api.parseStoreInstalledPackage(role, {
            ...installed(other, role),
            signatureKind: api.PACKAGE_REQUIRED_SIGNATURE_KIND,
          }),
        ).toThrow("STORE_CONTRACT_INVALID");
      }
    },
  );
  it.each(["store-v1", "local-test-v1"])(
    "%s still rejects unhealthy, stale, foreign-role and altered code claims",
    (profile) => {
      const api = receiver(profile);
      const row = installed(profile, "gui");
      for (const change of [
        { current: false },
        { healthy: false },
        { architecture: "arm64" },
        { publisher: "CN=Foreign" },
        { installedLocation: "C:\\untrusted" },
        { allowUnsigned: true },
      ])
        expect(() =>
          api.parseStoreInstalledPackage("gui", { ...row, ...change }),
        ).toThrow("STORE_CONTRACT_INVALID");
      expect(() =>
        api.parseStoreInstalledPackage("gui", installed(profile, "worker")),
      ).toThrow("STORE_CONTRACT_INVALID");
      expect(
        api.evaluateStorePackagePair(row, installed(profile, "worker")).ready,
      ).toBe(true);
    },
  );
  it.each(["store-v1", "local-test-v1"])(
    "%s requires its own sealed resource authority marker and exact namespace",
    (profile) => {
      const api = receiver(profile);
      const own = seal(profile);
      const other = seal(profile === "store-v1" ? "local-test-v1" : "store-v1");
      const receive = (value: unknown) =>
        api.parseStoreResourceIndexBytes(Buffer.from(JSON.stringify(value)));
      expect(receive(own).authority.kind).toBe(api.PACKAGE_AUTHORITY_KIND);
      expect(() => receive(other)).toThrow("STORE_RESOURCE_INDEX_INVALID");
      expect(() =>
        receive({
          ...own,
          authority: { ...own.authority, kind: other.authority.kind },
        }),
      ).toThrow("STORE_RESOURCE_INDEX_INVALID");
      expect(() =>
        receive({
          ...own,
          authority: { ...own.authority, identity: other.authority.identity },
        }),
      ).toThrow("STORE_RESOURCE_INDEX_INVALID");
    },
  );
  it("rejects an unknown compile-time profile before granting any receiving authority", () => {
    expect(() => require(outputs.get("foreign")!)).toThrow(
      "PACKAGE_BUILD_PROFILE_INVALID",
    );
  });
  it.each(["store-v1", "local-test-v1"])(
    "%s compiled output contains no runtime profile lookup",
    async (profile) => {
      const text = await readFile(outputs.get(profile)!, "utf8");
      expect(text).not.toContain("__MUSICMUTE_PACKAGE_AUTHORITY_PROFILE__");
      const selector = text.slice(
        text.indexOf("function compiledProfile()"),
        text.indexOf("function compiledProfile()") + 200,
      );
      expect(selector).not.toContain("process.env");
    },
  );
  it("leaves production's Electron name, data paths and filesystem untouched", () => {
    const application = {
      setName: vi.fn(),
      getPath: vi.fn(() => {
        throw new Error("PRODUCTION_DATA_MUST_NOT_BE_READ");
      }),
      setPath: vi.fn(),
      setAppUserModelId: vi.fn(),
    };
    receiver("store-v1").configureDesktopPackageIdentity(application);
    expect(application.setName).not.toHaveBeenCalled();
    expect(application.getPath).not.toHaveBeenCalled();
    expect(application.setPath).not.toHaveBeenCalled();
    expect(application.setAppUserModelId).toHaveBeenCalledExactlyOnceWith(
      "com.musicmute.local.windows",
    );
  });
  it("isolates development Chromium sessions and instance locks under a fixed owned leaf", async () => {
    const appData = await realpath(
      await mkdtemp(join(temporary, "electron-profile-")),
    );
    const application = {
      setName: vi.fn(),
      getPath: vi.fn(() => appData),
      setPath: vi.fn(),
      setAppUserModelId: vi.fn(),
    };
    const api = receiver("local-test-v1");
    api.configureDesktopPackageIdentity(application);
    const expected = join(appData, "MusicMute Development");
    expect(await realpath(expected)).toBe(expected);
    expect(application.setName).toHaveBeenCalledExactlyOnceWith(
      "MusicMute Development",
    );
    expect(application.getPath).toHaveBeenCalledExactlyOnceWith("appData");
    expect(application.setPath.mock.calls).toEqual([
      ["userData", expected],
      ["sessionData", expected],
    ]);
    expect(application.setAppUserModelId).toHaveBeenCalledExactlyOnceWith(
      "MusicMute.Development_kthggmwhkdz4t!MusicMute",
    );
    // Reusing the same genuine local-test profile does not change its data root.
    api.configureDesktopPackageIdentity(application);
    expect(await realpath(expected)).toBe(expected);
  });
  it("rejects a development leaf redirected into another application's data", async () => {
    const appData = await realpath(
      await mkdtemp(join(temporary, "electron-redirect-")),
    );
    const foreign = join(appData, "production-data");
    await mkdir(foreign);
    await writeFile(join(foreign, "retained.txt"), "unchanged");
    await symlink(foreign, join(appData, "MusicMute Development"), "junction");
    const application = {
      setName: vi.fn(),
      getPath: vi.fn(() => appData),
      setPath: vi.fn(),
      setAppUserModelId: vi.fn(),
    };
    expect(() =>
      receiver("local-test-v1").configureDesktopPackageIdentity(application),
    ).toThrow("DEVELOPMENT_DESKTOP_DATA_INVALID");
    expect(application.setPath).not.toHaveBeenCalled();
    expect(application.setAppUserModelId).not.toHaveBeenCalled();
    expect(await readFile(join(foreign, "retained.txt"), "utf8")).toBe(
      "unchanged",
    );
  });
  it("keeps production bootstrap errors generic even when a transport has development observations", () => {
    const api = receiver("store-v1");
    const diagnostic = new api.StoreGuiBootstrapDiagnostics();
    diagnostic.phase("native-boot");
    diagnostic.transport({
      request: async () => ({}),
      close: async () => {},
      storeBootstrapDiagnostics: [
        {
          phase: "child-assign",
          code: 4,
          win32: 5,
          wait: 0,
          exit: 0,
          active: 0,
          assigned: 0,
          listed: 0,
        },
      ],
    });
    const error = diagnostic.failure();
    expect(error.message).toBe("STORE_AUTHORITY_DENIED");
    expect(api.developmentBootstrapFailureText(error)).toBeUndefined();
  });
  it("shows only closed native observations and TS phase labels in a development error", () => {
    const api = receiver("local-test-v1");
    const diagnostic = new api.StoreGuiBootstrapDiagnostics();
    diagnostic.phase("native-boot");
    const rows = [
      {
        phase: "child-assign",
        code: 4,
        win32: 5,
        wait: 4294967295,
        exit: 259,
        active: 0,
        assigned: 1,
        listed: 0,
      },
    ];
    diagnostic.transport({
      request: async () => ({}),
      close: async () => {},
      storeBootstrapDiagnostics: rows as never,
    });
    const error = diagnostic.failure();
    rows[0]!.win32 = 999;
    error.message = "private-path token=private-secret";
    error.stack = "private-stack";
    const text = api.developmentBootstrapFailureText(error)!;
    expect(text).toContain("TS phase: native-boot");
    expect(text).toContain(
      "Native phase=child-assign code=4 win32=5 wait=4294967295 exit=259 active=0 assigned=1 listed=0",
    );
    expect(text).not.toContain("private");
    expect(text).not.toContain("999");
  });
  it("never reads diagnostic getters or formats arbitrary thrown errors", () => {
    const api = receiver("local-test-v1");
    const diagnostic = new api.StoreGuiBootstrapDiagnostics();
    let getterCalled = false;
    const row = {
      code: 0,
      win32: 0,
      wait: 0,
      exit: 0,
      active: 0,
      assigned: 0,
      listed: 0,
    };
    Object.defineProperty(row, "phase", {
      enumerable: true,
      get() {
        getterCalled = true;
        return "private-path";
      },
    });
    diagnostic.transport({
      request: async () => ({}),
      close: async () => {},
      storeBootstrapDiagnostics: [row] as never,
    });
    expect(
      api.developmentBootstrapFailureText(diagnostic.failure()),
    ).not.toContain("Native phase");
    expect(getterCalled).toBe(false);
    api.markDesktopBootstrapPhase("resource-trust");
    const raw = new Error("private-path");
    raw.stack = "private-token";
    const text = api.developmentBootstrapFailureText(raw)!;
    expect(text).toContain("TS phase: resource-trust");
    expect(text).not.toContain("private");
    expect(
      api.developmentBootstrapFailureText({ message: "private" }),
    ).not.toContain("private");
  });
  it.each(["default", "store-v1"])(
    "%s suppresses late diagnostics without reading observations or awaiting retirement",
    async (profile) => {
      const api = receiver(profile),
        diagnostic = new api.StoreGuiBootstrapDiagnostics(),
        observe = vi.fn(() => {
          throw new Error("private transport state");
        }),
        then = vi.fn(() => {
          throw new Error("private cleanup state");
        }),
        read = vi.fn(async () => {
          throw new Error("private error");
        }),
        display = vi.fn();
      diagnostic.phase("account-owner");
      diagnostic.transport({
        request: async () => ({}),
        close: async () => {},
        get storeBootstrapDiagnostics() {
          return observe();
        },
      });
      // eslint-disable-next-line unicorn/no-thenable -- Deliberately hostile cleanup observation.
      const closing = Object.defineProperty({}, "then", { get: then });
      await expect(
        diagnostic.closedFailure(closing as Promise<void>),
      ).resolves.toBeUndefined();
      await api.displayDevelopmentClosedFailure(read, display);
      expect(observe).not.toHaveBeenCalled();
      expect(then).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(display).not.toHaveBeenCalled();
    },
  );
  it("displays a late parsed denial after the original retirement drains, once only", async () => {
    const api = receiver("local-test-v1"),
      diagnostic = new api.StoreGuiBootstrapDiagnostics(),
      rows: NonNullable<
        ReturnType<typeof parseStoreBootstrapDiagnosticLine>
      >[] = [],
      readObservations = vi.fn(() => rows),
      close = vi.fn(async () => {}),
      request = vi.fn(async () => ({})),
      display = vi.fn();
    let drained!: () => void;
    const closing = new Promise<void>((resolve) => {
      drained = resolve;
    });
    diagnostic.phase("account-owner");
    diagnostic.transport({
      close,
      request,
      get storeBootstrapDiagnostics() {
        return readObservations();
      },
    });
    const failure = diagnostic.closedFailure(closing),
      presenting = api.displayDevelopmentClosedFailure(() => failure, display);
    await Promise.resolve();
    expect(readObservations).not.toHaveBeenCalled();
    expect(display).not.toHaveBeenCalled();
    const denial = parseStoreBootstrapDiagnosticLine(
      Buffer.from(
        "MMDEV1 phase=store-dispatch code=5 win32=2147942405 wait=4294967295 exit=4294967295 active=4294967295 assigned=4294967295 listed=4294967295\n",
      ),
    );
    expect(denial).toBeDefined();
    rows.push(denial!);
    drained();
    await presenting;
    await Promise.all([
      api.displayDevelopmentClosedFailure(() => failure, display),
      api.displayDevelopmentClosedFailure(() => failure, display),
    ]);
    expect(display).toHaveBeenCalledOnce();
    expect(display.mock.calls[0]![0]).toContain("TS phase: account-owner");
    expect(display.mock.calls[0]![0]).toContain(
      "Native phase=store-dispatch code=5 win32=2147942405",
    );
    expect(readObservations).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
  it("retains numeric diagnostics after rejected cleanup without changing that rejection", async () => {
    const api = receiver("local-test-v1"),
      diagnostic = new api.StoreGuiBootstrapDiagnostics(),
      original = new Error("private cleanup path token=private"),
      closing = Promise.reject(original),
      originalResult = expect(closing).rejects.toBe(original),
      display = vi.fn();
    diagnostic.phase("account-owner");
    diagnostic.transport({
      close: async () => {},
      request: async () => ({}),
      storeBootstrapDiagnostics: [
        parseStoreBootstrapDiagnosticLine(
          Buffer.from(
            "MMDEV1 phase=store-dispatch code=6 win32=5 wait=0 exit=2 active=0 assigned=0 listed=0\n",
          ),
        )!,
      ],
    });
    const failure = (await diagnostic.closedFailure(closing))!;
    failure.message = "private native path";
    failure.stack = "private stack token=secret";
    await api.displayDevelopmentClosedFailure(async () => failure, display);
    await originalResult;
    expect(display).toHaveBeenCalledOnce();
    expect(display.mock.calls[0]![0]).toContain(
      "Native phase=store-dispatch code=6 win32=5",
    );
    expect(display.mock.calls[0]![0]).not.toMatch(/private|secret|token/u);
  });
  it("observes the existing close before the account rejection and drains late stderr", async () => {
    const api = receiver("local-test-v1"),
      diagnostic = new api.StoreGuiBootstrapDiagnostics(),
      child = Object.assign(new EventEmitter(), {
        pid: 9001,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(() => true),
      }),
      transport = new ConsumerNativeChildTransport(
        child as unknown as ChildProcessWithoutNullStreams,
      ),
      close = vi.spyOn(transport, "close"),
      display = vi.fn(),
      order: string[] = [];
    let closing: Promise<void> | undefined,
      presenting: Promise<void> | undefined;
    diagnostic.phase("account-owner");
    diagnostic.transport(transport);
    // Authority registers its close listener during construction; bootstrap
    // registers the primary account listener only after opening that authority.
    transport.onClosed(() => {
      order.push("authority-close-started");
      closing = transport.close();
    });
    transport.onClosed(() => {
      order.push("publish", "app.quit");
      presenting = api.displayDevelopmentClosedFailure(() => {
        order.push("observe");
        expect(closing).toBeDefined();
        return diagnostic.closedFailure(closing!);
      }, display);
    });
    const failed = transport
      .request("store_account_peer_verify", {}, 100)
      .catch((error: unknown) => {
        order.push("request-rejected");
        return error;
      });
    await failed;
    expect(order).toEqual([
      "authority-close-started",
      "publish",
      "app.quit",
      "observe",
      "request-rejected",
    ]);
    expect(display).not.toHaveBeenCalled();
    const stdoutEnd = once(child.stdout, "end"),
      stderrEnd = once(child.stderr, "end");
    child.stdout.end();
    child.stderr.end(
      "private path token=secret\nMMDEV1 phase=store-dispatch code=5 win32=2147942405 wait=0 exit=2 active=0 assigned=0 listed=0\n",
    );
    await Promise.all([stdoutEnd, stderrEnd]);
    expect(display).not.toHaveBeenCalled();
    child.emit("close", 2);
    await closing;
    await presenting;
    expect(close).toHaveBeenCalledOnce();
    expect(display).toHaveBeenCalledOnce();
    expect(display.mock.calls[0]![0]).toContain(
      "Native phase=store-dispatch code=5 win32=2147942405",
    );
    expect(display.mock.calls[0]![0]).not.toMatch(/private|secret|token/u);
  });
  it("contains diagnostic-reader/display failures and refuses unbranded errors", async () => {
    const api = receiver("local-test-v1"),
      display = vi.fn(),
      diagnostic = new api.StoreGuiBootstrapDiagnostics();
    await expect(
      api.displayDevelopmentClosedFailure(async () => {
        throw new Error("private reader");
      }, display),
    ).resolves.toBeUndefined();
    await api.displayDevelopmentClosedFailure(
      async () => new Error("private unbranded"),
      display,
    );
    expect(display).not.toHaveBeenCalled();
    diagnostic.phase("account-owner");
    const failure = await diagnostic.closedFailure(Promise.resolve());
    const failedDisplay = vi.fn(() => {
      throw new Error("private display failure");
    });
    await expect(
      api.displayDevelopmentClosedFailure(async () => failure, failedDisplay),
    ).resolves.toBeUndefined();
    await api.displayDevelopmentClosedFailure(
      async () => failure,
      failedDisplay,
    );
    expect(failedDisplay).toHaveBeenCalledOnce();
  });
});
