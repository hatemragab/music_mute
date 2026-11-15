import { expect, it, vi } from "vitest";
import type { HostContext } from "../src/main/host-context.js";
import type { StorePreparationOperations } from "../src/main/prepare/store-operations.js";
import type { StorePersonalRuntime } from "../src/main/personal/store-runtime.js";

// Synthetic factory receiving tests. Existing native/runtime module boundaries
// are mocked; these values do not establish Windows Store package authority.
const mocks = vi.hoisted(() => {
  class Authority {
    #alive = true;
    creatorProof() {
      if (!this.#alive) throw Error("CLOSED");
      return {};
    }
    close() {
      this.#alive = false;
    }
  }
  class GuiExecution {
    closeCalls = 0;
    close() {
      this.closeCalls++;
      return Promise.resolve();
    }
  }
  class Session {
    #host: unknown;
    calls: unknown[] = [];
    execution = new GuiExecution();
    afterOpen = () => {};
    constructor(host: unknown) {
      this.#host = host;
    }
    openMedia(configuration: unknown) {
      if (!this.#host) throw Error("FOREIGN_SESSION");
      this.calls.push(configuration);
      this.afterOpen();
      return Promise.resolve(this.execution);
    }
  }
  class Operations {
    #view: unknown;
    #host: unknown;
    calls = 0;
    session: Session;
    sessionCalls = 0;
    constructor(host: unknown, view: unknown) {
      this.#host = host;
      this.#view = view;
      this.session = new Session(host);
    }
    assertHost(host: unknown) {
      if (host !== this.#host) throw Error("OPERATIONS_DENIED");
    }
    async mediaCodeView(signal: AbortSignal) {
      signal.throwIfAborted();
      this.calls++;
      return this.#view;
    }
    async maintenanceSession() {
      this.sessionCalls++;
      return this.session;
    }
  }
  class Personal {
    #host: unknown;
    #view: unknown;
    configuration = Object.freeze({ distribution: "microsoft-store" });
    calls = 0;
    mediaCalls: unknown[][] = [];
    constructor(host: unknown, view: unknown) {
      this.#host = host;
      this.#view = view;
    }
    assertConfiguration(host: unknown, configuration: unknown) {
      if (host !== this.#host || configuration !== this.configuration)
        throw Error("PERSONAL_DENIED");
    }
    async mediaCodeView(signal: AbortSignal) {
      signal.throwIfAborted();
      this.calls++;
      return this.#view;
    }
    async runMedia(configuration: unknown, signal: AbortSignal) {
      signal.throwIfAborted();
      this.mediaCalls.push([configuration, signal]);
    }
  }
  return {
    Authority,
    Session,
    GuiExecution,
    Operations,
    Personal,
    owners: new WeakMap<object, Authority>(),
  };
});
vi.mock("../src/main/browser/store-native.js", () => ({
  StoreNativeAuthority: mocks.Authority,
  storeAuthorityForDataNative: (native: object) => mocks.owners.get(native),
}));
vi.mock("../src/main/session/store-session-client.js", () => ({
  StoreSessionClient: mocks.Session,
}));
vi.mock("../src/main/session/store-gui-media.js", () => ({
  StoreGuiMediaExecution: mocks.GuiExecution,
}));
vi.mock("../src/main/prepare/store-operations.js", () => ({
  StorePreparationOperations: mocks.Operations,
}));
vi.mock("../src/main/personal/store-runtime.js", () => ({
  StorePersonalRuntime: mocks.Personal,
}));
import { STORE_PRODUCTS } from "../src/shared/store-contracts.js";
import { StoreMediaTools } from "../src/main/prepare/store-media-tools.js";
import {
  mediaToolRelease,
  runOwnedMediaOperation,
} from "../src/main/prepare/owned-media-operation.js";

const sid = "S-1-5-21-4161902177-57482701-1680932209-1000",
  inventory = "a".repeat(64),
  manifestHash = "b".repeat(64),
  helperHash = "c".repeat(64);
function fixture() {
  const product = STORE_PRODUCTS.worker,
    fullName = `${product.identityName}_0.1.3.2_x64__${product.publisherId}`;
  const authority = new mocks.Authority(),
    native = {},
    view = {
      binding: {
        sid,
        inventorySha256: inventory,
        runtimeManifestSha256: manifestHash,
        bootIdentity: "e".repeat(64),
        recipeDigests: {
          "kim-vocals-v2": "0".repeat(64),
          "kim-vocals-v2-trim": "1".repeat(64),
        },
        package: {
          identityName: product.identityName,
          publisher: product.publisher,
          publisherId: product.publisherId,
          familyName: product.familyName,
          fullName,
          packageVersion: "0.1.3.2",
          architecture: "x64",
          signatureKind: 3,
          healthy: true,
          current: true,
          installedLocation: `C:\\Program Files\\WindowsApps\\${fullName}`,
        },
      },
      workerRoot: `C:\\Program Files\\WindowsApps\\${fullName}\\worker`,
      manifest: {
        entries: [
          {
            kind: "file",
            path: "runtime/native/musicmute-native.exe",
            bytes: 32,
            sha256: helperHash,
          },
        ],
      },
    },
    host = {
      native,
      storeAuthority: authority,
      identity: { sid },
      prepareLease: vi.fn(),
    } as unknown as HostContext,
    operations = new mocks.Operations(host, view);
  mocks.owners.set(native, authority);
  return {
    authority,
    native,
    view,
    host,
    operations,
    tools: () =>
      StoreMediaTools.open(
        host,
        operations as unknown as StorePreparationOperations,
      ),
  };
}
it("keeps GUI construction passive when no Worker has been acquired", () => {
  const f = fixture();
  f.tools();
  expect(f.operations.calls).toBe(0);
  expect(f.operations.sessionCalls).toBe(0);
});
it("returns the actual protected worker path and distinct inventory identity", async () => {
  const f = fixture(),
    result = await f.tools().snapshotMediaTools(new AbortController().signal);
  expect(result).toMatchObject({
    distribution: "microsoft-store",
    releaseRoot: f.view.workerRoot,
    releaseIdentity: inventory,
    manifestSha256: manifestHash,
    nativeSha256: helperHash,
    ffmpegPath: f.view.workerRoot + "\\runtime\\bin\\ffmpeg.exe",
  });
  expect(mediaToolRelease(result)).toBe(inventory);
  expect(Object.isFrozen(result)).toBe(true);
  expect(f.operations.sessionCalls).toBe(0);
});
it("preserves legacy release identity from its real release-directory leaf", () => {
  expect(
    mediaToolRelease({
      releaseRoot: "C:\\data\\runtime\\releases\\" + inventory,
      manifestSha256: manifestHash,
      nativeSha256: helperHash,
      ffmpegPath: "fixed",
      ffprobePath: "fixed",
    }),
  ).toBe(inventory);
});
it("rejects forged options and lost native ownership", async () => {
  const f = fixture();
  expect(() =>
    StoreMediaTools.open(f.host, {} as StorePreparationOperations),
  ).toThrow();
  const foreign = fixture();
  expect(() =>
    StoreMediaTools.open(
      f.host,
      foreign.operations as unknown as StorePreparationOperations,
    ),
  ).toThrow("OPERATIONS_DENIED");
  expect(f.operations.calls).toBe(0);
  expect(foreign.operations.calls).toBe(0);
  mocks.owners.delete(f.native);
  expect(() => f.tools()).toThrow("MEDIA_TOOLS_REQUIRED");
});
it("rechecks the actual Operations prototype without borrowing an override", () => {
  const f = fixture(),
    tools = f.tools(),
    override = vi.fn();
  Object.defineProperty(f.operations, "assertHost", { value: override });
  tools.assertHost(f.host);
  expect(override).not.toHaveBeenCalled();
});
it("revalidates live creator and original Host on every view", async () => {
  const f = fixture(),
    tools = f.tools();
  expect(() => tools.assertHost({ ...f.host } as HostContext)).toThrow(
    "MEDIA_TOOLS_REQUIRED",
  );
  f.authority.close();
  await expect(
    tools.snapshotMediaTools(new AbortController().signal),
  ).rejects.toThrow("CLOSED");
});
it("rejects a foreign SID, missing helper, or redirected worker root", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.view.binding.sid = "S-1-5-21-1-2-3-4";
    },
    (f: ReturnType<typeof fixture>) => {
      f.view.manifest.entries = [];
    },
    (f: ReturnType<typeof fixture>) => {
      f.view.workerRoot = "C:\\writable\\worker";
    },
  ]) {
    const f = fixture();
    change(f);
    await expect(
      f.tools().snapshotMediaTools(new AbortController().signal),
    ).rejects.toThrow("MEDIA_TOOLS_REQUIRED");
  }
});
it("binds personal tools to their actual original runtime and data Host", async () => {
  const f = fixture(),
    nodeHost = {
      ...f.host,
      storeAuthority: undefined,
    } as unknown as HostContext,
    runtime = new mocks.Personal(nodeHost, f.view),
    tools = StoreMediaTools.forPersonal(
      nodeHost,
      runtime as unknown as StorePersonalRuntime,
    );
  expect(runtime.calls).toBe(0);
  expect(
    (await tools.snapshotMediaTools(new AbortController().signal))
      .releaseIdentity,
  ).toBe(inventory);
  expect(() =>
    StoreMediaTools.forPersonal(
      f.host,
      runtime as unknown as StorePersonalRuntime,
    ),
  ).toThrow("PERSONAL_DENIED");
  await expect(tools.session(new AbortController().signal)).rejects.toThrow(
    "MEDIA_TOOLS_REQUIRED",
  );
});
it("rejects invalid Store configuration without any legacy launch", async () => {
  const f = fixture(),
    nodeHost = {
      ...f.host,
      storeAuthority: undefined,
    } as unknown as HostContext,
    runtime = new mocks.Personal(nodeHost, f.view);
  for (const [host, tools] of [
    [f.host, f.tools()],
    [
      nodeHost,
      StoreMediaTools.forPersonal(
        nodeHost,
        runtime as unknown as StorePersonalRuntime,
      ),
    ],
  ] as const) {
    const configure = vi.fn();
    await expect(
      runOwnedMediaOperation({
        host,
        tools,
        signal: new AbortController().signal,
        configuration: configure,
        resultRelative: () => "fixed",
        parse: () => null,
        maxResultBytes: 4096,
      }),
    ).rejects.toThrow("MEDIA_TOOLS_REQUIRED");
    expect(configure).toHaveBeenCalledOnce();
    expect(f.host.prepareLease).not.toHaveBeenCalled();
  }
});
it("delegates Personal CPU work only through its original runtime prototype", async () => {
  const f = fixture(),
    nodeHost = {
      ...f.host,
      storeAuthority: undefined,
    } as unknown as HostContext,
    runtime = new mocks.Personal(nodeHost, f.view),
    tools = StoreMediaTools.forPersonal(
      nodeHost,
      runtime as unknown as StorePersonalRuntime,
    ),
    configuration = {
      version: 1 as const,
      operation: "diagnostics_doctor" as const,
      requestId: "12345678-1234-4234-8234-123456789012",
      executionId: "23456789-1234-4234-8234-123456789012",
      release: inventory,
      manifestSha256: manifestHash,
      helperSha256: helperHash,
      sid,
    },
    signal = new AbortController().signal;
  const override = vi.fn();
  Object.defineProperty(runtime, "runMedia", { value: override });
  await tools.runMedia(configuration, signal);
  expect(runtime.mediaCalls).toEqual([[configuration, signal]]);
  expect(override).not.toHaveBeenCalled();
  expect(f.host.prepareLease).not.toHaveBeenCalled();
});
it("denies GUI media delegation before pending Session factory or legacy launch", async () => {
  const f = fixture();
  await expect(
    f.tools().runMedia({} as never, new AbortController().signal),
  ).rejects.toThrow("MEDIA_TOOLS_REQUIRED");
  expect(f.operations.sessionCalls).toBe(0);
  expect(f.host.prepareLease).not.toHaveBeenCalled();
});

function doctorConfiguration() {
  return {
    version: 1,
    operation: "diagnostics_doctor",
    requestId: "12345678-1234-4234-8234-123456789012",
    executionId: "23456789-1234-4234-8234-123456789012",
    release: inventory,
    manifestSha256: manifestHash,
    helperSha256: helperHash,
    sid,
  };
}
it("opens GUI CPU work only through the original genuine borrowed Session prototype, before any workspace or child effects", async () => {
  const f = fixture(),
    tools = f.tools(),
    override = vi.fn();
  Object.defineProperty(f.operations.session, "openMedia", { value: override });
  expect(f.operations.sessionCalls).toBe(0);
  const execution = await tools.openMedia(doctorConfiguration());
  expect(execution).toBe(f.operations.session.execution);
  expect(f.operations.sessionCalls).toBe(1);
  expect(f.operations.session.calls).toEqual([doctorConfiguration()]);
  expect(override).not.toHaveBeenCalled();
  expect(f.host.prepareLease).not.toHaveBeenCalled();
});
it("retains and closes the actual newly returned GUI execution when its original data owner is lost", async () => {
  const f = fixture(),
    tools = f.tools();
  f.operations.session.afterOpen = () => {
    mocks.owners.delete(f.native);
  };
  await expect(tools.openMedia(doctorConfiguration())).rejects.toThrow(
    "MEDIA_TOOLS_REQUIRED",
  );
  expect(f.operations.session.execution.closeCalls).toBe(1);
});
