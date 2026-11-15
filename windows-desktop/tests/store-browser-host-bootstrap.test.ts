import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { STORE_BROWSER_ORIGIN } from "../src/main/browser/store-registration.js";

// Run the actual browser-host entry function with receiving-only factories.
// These mocks prove ordering/grammar/cleanup, never genuine Store/Chrome/GUI,
// account sign-in, peer birth, package generation or kernel endpoint authority.
const fixture = vi.hoisted(() => ({
  order: [] as string[],
  host: undefined as unknown,
  natives: [] as {
    close: ReturnType<typeof vi.fn>;
    processIdentity: ReturnType<typeof vi.fn>;
  }[],
  authorities: [] as object[],
  ports: [] as object[],
  clientArgs: [] as unknown[][],
  openEvents: false,
  mapMissing: false,
  connectFailure: undefined as Error | undefined,
  factoryFailure: undefined as Error | undefined,
  serviceOptions: undefined as
    | {
        getSession: () => Promise<unknown>;
        personalPeer: () => Promise<unknown>;
      }
    | undefined,
  clientClose: vi.fn(async () => undefined),
  serviceClose: vi.fn(async () => undefined),
  serviceCommand: vi.fn<(input: unknown) => Promise<void>>(
    async () => undefined,
  ),
  manifest: vi.fn(),
  build: vi.fn(),
  openHost: vi.fn(),
  openNative: vi.fn(),
  deriveNative: vi.fn(),
  borrowNative: vi.fn(),
  pin: vi.fn(),
  lookup: vi.fn(),
  openPort: vi.fn(),
  media: vi.fn(),
  session: vi.fn(),
  storeSession: vi.fn(),
  storeSessionClose: vi.fn(async () => undefined),
}));
vi.mock("../src/main/session/store-session-client.js", () => ({
  StoreSessionClient: class {
    static async openBrowser(source: unknown) {
      await fixture.storeSession(source);
      return new this();
    }
    personalPeer() {
      return {
        sid: "S-1-5-21-1-2-3-1001",
        sessionId: 1,
        pid: 751,
        creationTime: "1337133713371337",
      };
    }
    close() {
      fixture.order.push("store-session-close");
      return fixture.storeSessionClose();
    }
  },
}));
vi.mock("../src/main/host-context.js", () => ({
  openWindowsHost: (...args: unknown[]) => fixture.openHost(...args),
}));
vi.mock("../src/main/session/desktop-client.js", () => ({
  openDesktopSessionClient: (...args: unknown[]) => fixture.session(...args),
}));
vi.mock("../src/main/browser/registration.js", () => ({
  loadBrowserIntegrationManifest: (...args: unknown[]) =>
    fixture.manifest(...args),
}));
vi.mock("../src/main/browser/package-trust.js", () => ({
  loadPackagedDesktopBuild: (...args: unknown[]) => fixture.build(...args),
}));
vi.mock("../src/main/browser/native.js", () => ({
  loadBrowserAccountAppPin: (...args: unknown[]) => fixture.pin(...args),
  openBrowserNative: (...args: unknown[]) => fixture.openNative(...args),
}));
vi.mock("../src/main/browser/store-native.js", () => ({
  storeAuthorityForDataNative: (...args: unknown[]) => fixture.lookup(...args),
  StoreNativeAuthority: class {
    static openBrowserWaitingPeer(...args: unknown[]) {
      return fixture.deriveNative(...args);
    }
    borrowDataNative() {
      return fixture.borrowNative(this);
    }
  },
}));
vi.mock("../src/main/browser/store-account-native.js", () => ({
  openStoreAccountNative: (...args: unknown[]) => fixture.openPort(...args),
}));
vi.mock("../src/main/browser/media.js", () => ({
  createBrowserMedia: (...args: unknown[]) => fixture.media(...args),
}));
vi.mock("../src/main/browser/account-bridge.js", () => ({
  BrowserAccountClient: class {
    constructor(...args: unknown[]) {
      fixture.clientArgs.push(args);
      fixture.order.push("account-client");
    }
    async connect() {
      fixture.order.push("connect");
      if (fixture.openEvents)
        await (fixture.clientArgs.at(-1)![2] as () => Promise<unknown>)();
      if (fixture.connectFailure) throw fixture.connectFailure;
    }
    close() {
      fixture.order.push("account-close");
      return fixture.clientClose();
    }
  },
}));
vi.mock("../src/main/browser/service.js", () => ({
  WindowsBrowserService: class {
    constructor(options: {
      getSession: () => Promise<unknown>;
      personalPeer: () => Promise<unknown>;
    }) {
      fixture.serviceOptions = options;
      fixture.order.push("service");
    }
    command(input: unknown) {
      return fixture.serviceCommand(input);
    }
    close() {
      fixture.order.push("service-close");
      return fixture.serviceClose();
    }
  },
}));
import { runBrowserHost } from "../src/agent/browser-host.js";

const realProcess = process;
let fakeProcess: NodeJS.Process;
const resources = "C:\\MusicMuteQa\\resources";
const args = () => [
  "--origin",
  STORE_BROWSER_ORIGIN,
  "--resources",
  resources,
  "--store-browser-host",
  "600",
  "--store-browser-nonce",
  "a".repeat(64),
];
function host() {
  return fixture.host as {
    storeAuthority: { browserAttach: ReturnType<typeof vi.fn> } | undefined;
    close: ReturnType<typeof vi.fn>;
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  fixture.clientClose.mockResolvedValue(undefined);
  fixture.serviceClose.mockResolvedValue(undefined);
  fixture.storeSessionClose.mockResolvedValue(undefined);
  fixture.order.length = 0;
  fixture.natives.length = 0;
  fixture.authorities.length = 0;
  fixture.ports.length = 0;
  fixture.clientArgs.length = 0;
  fixture.openEvents = false;
  fixture.mapMissing = false;
  fixture.connectFailure = undefined;
  fixture.factoryFailure = undefined;
  fixture.serviceOptions = undefined;
  fakeProcess = {
    ...realProcess,
    platform: "win32",
    arch: "x64",
    windowsStore: true,
    env: {
      MUSICMUTE_OWNERSHIP_NONCE: "caller",
      MUSICMUTE_OWNERSHIP_ROLE: "caller",
    },
    stdin: Readable.from([]),
    stdout: { write: vi.fn(() => true) },
  } as unknown as NodeJS.Process;
  vi.stubGlobal("process", fakeProcess);
  fixture.host = {
    storeAuthority: {
      browserAttach: vi.fn(async () => {
        fixture.order.push("attach");
      }),
    },
    close: vi.fn(async () => {
      fixture.order.push("host-close");
    }),
  };
  fixture.manifest.mockImplementation(async () => {
    fixture.order.push("manifest");
    return { extensionId: STORE_BROWSER_ORIGIN.split("//")[1]!.slice(0, -1) };
  });
  fixture.build.mockImplementation(async () => {
    fixture.order.push("build");
    return { appVersion: "0.1.0", buildNumber: 1 };
  });
  fixture.openHost.mockImplementation(async () => {
    fixture.order.push("host");
    return fixture.host;
  });
  const receivingNative = () => {
    const native = {
      close: vi.fn(async () => {
        fixture.order.push("native-close");
      }),
      processIdentity: vi.fn(),
    };
    fixture.natives.push(native);
    fixture.authorities.push(
      Object.freeze({
        source: "receiving-fixture",
        helper: fixture.natives.length,
        gui: 500,
      }),
    );
    return native;
  };
  fixture.openNative.mockImplementation(async () => {
    fixture.order.push("native");
    return receivingNative();
  });
  fixture.deriveNative.mockImplementation(async () => {
    fixture.order.push("derived");
    receivingNative();
    return fixture.authorities.at(-1);
  });
  fixture.borrowNative.mockImplementation((authority: object) => {
    fixture.order.push("borrow");
    return fixture.natives[fixture.authorities.indexOf(authority)];
  });
  fixture.lookup.mockImplementation((native: object) => {
    fixture.order.push("lookup");
    return fixture.mapMissing
      ? undefined
      : fixture.authorities[
          fixture.natives.indexOf(native as (typeof fixture.natives)[number])
        ];
  });
  fixture.openPort.mockImplementation(async (authority: object) => {
    fixture.order.push("port");
    if (fixture.factoryFailure) throw fixture.factoryFailure;
    const port = Object.freeze({ fixtureAuthority: authority });
    fixture.ports.push(port);
    return port;
  });
  fixture.pin.mockResolvedValue(
    Object.freeze({
      sha256: "e".repeat(64),
      bytes: 1234,
      publisherSha256: "f".repeat(64),
    }),
  );
  fixture.media.mockImplementation(async () => {
    fixture.order.push("media");
    return {};
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("actual Store browser-host bootstrap source with receiving-only factories", () => {
  it.each(
    [[], args().slice(0, 4), [...args(), "--extra"]].map((input) => ({
      input,
    })),
  )(
    "rejects wrong Store argv count before resource/host factories",
    async ({ input }) => {
      await expect(runBrowserHost(input)).rejects.toThrow(
        "BROWSER_HOST_UNAVAILABLE",
      );
      expect(fixture.order).toEqual([]);
    },
  );
  it("rejects unsupported Windows architecture and clears inherited legacy role claims", async () => {
    Object.assign(fakeProcess, { arch: "arm64" });
    await expect(runBrowserHost(args())).rejects.toThrow(
      "BROWSER_HOST_UNAVAILABLE",
    );
    expect(fakeProcess.env).not.toHaveProperty("MUSICMUTE_OWNERSHIP_NONCE");
    expect(fakeProcess.env).not.toHaveProperty("MUSICMUTE_OWNERSHIP_ROLE");
    expect(fixture.order).toEqual([]);
  });
  it.each([
    { index: 4, value: "--caller-host" },
    { index: 6, value: "--caller-nonce" },
    { index: 5, value: "0600" },
    { index: 5, value: "2147483648" },
    { index: 5, value: "-1" },
    { index: 7, value: "A".repeat(64) },
    { index: 7, value: "a".repeat(63) },
  ])(
    "refuses closed host/nonce grammar %j and retires opened Host",
    async ({ index, value }) => {
      const input = args();
      input[index] = value;
      await expect(runBrowserHost(input)).rejects.toThrow(
        "STORE_BROWSER_DENIED",
      );
      expect(host().storeAuthority!.browserAttach).not.toHaveBeenCalled();
      expect(fixture.openNative).not.toHaveBeenCalled();
      expect(fixture.pin).not.toHaveBeenCalled();
      expect(host().close).toHaveBeenCalledOnce();
    },
  );
  it("checks the fixed extension before opening the Host and rejects unframed origin at attach", async () => {
    const input = args();
    input[1] = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";
    await expect(runBrowserHost(input)).rejects.toThrow(
      "EXTENSION_ORIGIN_REQUIRED",
    );
    expect(fixture.openHost).not.toHaveBeenCalled();
    const missingSlash = args();
    missingSlash[1] = STORE_BROWSER_ORIGIN.slice(0, -1);
    await expect(runBrowserHost(missingSlash)).rejects.toThrow(
      "STORE_BROWSER_DENIED",
    );
    expect(fixture.openNative).not.toHaveBeenCalled();
    expect(host().close).toHaveBeenCalledOnce();
  });
  it("attaches actual Host authority before opening account/helper factories and keeps legacy pins out", async () => {
    await runBrowserHost(args());
    expect(host().storeAuthority!.browserAttach).toHaveBeenCalledWith({
      hostPid: 600,
      nonce: "a".repeat(64),
      origin: STORE_BROWSER_ORIGIN,
    });
    expect(fixture.order.slice(0, 10)).toEqual([
      "manifest",
      "build",
      "host",
      "attach",
      "derived",
      "borrow",
      "lookup",
      "port",
      "account-client",
      "connect",
    ]);
    expect(fixture.clientArgs[0]![0]).toBe(fixture.ports[0]);
    expect(fixture.clientArgs[0]![1]).toBeUndefined();
    expect(fixture.deriveNative).toHaveBeenCalledWith(host().storeAuthority);
    expect(fixture.openNative).not.toHaveBeenCalled();
    expect(fixture.pin).not.toHaveBeenCalled();
    expect(fixture.serviceClose).toHaveBeenCalledOnce();
    expect(fixture.natives[0]!.close).toHaveBeenCalledOnce();
    expect(host().close).toHaveBeenCalledOnce();
  });
  it("opens a distinct event helper through its own actual data-authority lookup under the same GUI", async () => {
    fixture.openEvents = true;
    await runBrowserHost(args());
    expect(fixture.natives).toHaveLength(2);
    expect(fixture.natives[0]).not.toBe(fixture.natives[1]);
    expect(fixture.lookup.mock.calls.map(([native]) => native)).toEqual(
      fixture.natives,
    );
    expect(fixture.openPort.mock.calls.map(([authority]) => authority)).toEqual(
      fixture.authorities,
    );
    expect(fixture.authorities[0]).not.toBe(fixture.authorities[1]);
    expect(fixture.deriveNative.mock.calls.map(([source]) => source)).toEqual([
      host().storeAuthority,
      host().storeAuthority,
    ]);
    expect(fixture.openNative).not.toHaveBeenCalled();
    expect(
      fixture.authorities.map(
        (authority) => (authority as { gui: number }).gui,
      ),
    ).toEqual([500, 500]);
    expect(fixture.pin).not.toHaveBeenCalled();
  });
  it("opens the exact attached Store browser client and retires it before its original Host", async () => {
    const bytes = Buffer.from(
        JSON.stringify({
          protocol_version: 1,
          request_id: "ab9c4c74-7e0d-4cbd-9f04-2d5ce37019a7",
          type: "CHECK",
          payload: {},
        }),
      ),
      length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    Object.assign(fakeProcess, {
      stdin: Readable.from([Buffer.concat([length, bytes])]),
    });
    fixture.serviceCommand.mockImplementation(async () => {
      const first = await fixture.serviceOptions!.getSession();
      expect(await fixture.serviceOptions!.getSession()).toBe(first);
      expect(await fixture.serviceOptions!.personalPeer()).toEqual({
        sid: "S-1-5-21-1-2-3-1001",
        sessionId: 1,
        pid: 751,
        creationTime: "1337133713371337",
      });
    });
    await runBrowserHost(args());
    expect(fixture.storeSession).toHaveBeenCalledExactlyOnceWith(
      host().storeAuthority,
    );
    expect(fixture.storeSessionClose).toHaveBeenCalledOnce();
    expect(fixture.order.indexOf("store-session-close")).toBeLessThan(
      fixture.order.indexOf("host-close"),
    );
    expect(fixture.session).not.toHaveBeenCalled();
  });
  it("fails attachment before any account operation and closes the Host", async () => {
    host().storeAuthority!.browserAttach.mockRejectedValue(
      new Error("FIXTURE_ATTACH_DENIED"),
    );
    await expect(runBrowserHost(args())).rejects.toThrow(
      "FIXTURE_ATTACH_DENIED",
    );
    expect(fixture.openNative).not.toHaveBeenCalled();
    expect(fixture.openPort).not.toHaveBeenCalled();
    expect(fixture.deriveNative).not.toHaveBeenCalled();
    expect(fixture.pin).not.toHaveBeenCalled();
    expect(host().close).toHaveBeenCalledOnce();
  });
  it("refuses missing genuine Host authority without falling back to legacy", async () => {
    host().storeAuthority = undefined;
    await expect(runBrowserHost(args())).rejects.toThrow(
      "STORE_BROWSER_DENIED",
    );
    expect(fixture.openNative).not.toHaveBeenCalled();
    expect(fixture.pin).not.toHaveBeenCalled();
    expect(host().close).toHaveBeenCalledOnce();
  });
  it("retires a failed unbranded data helper and never creates an account client", async () => {
    fixture.mapMissing = true;
    await runBrowserHost(args());
    expect(fixture.openPort).not.toHaveBeenCalled();
    expect(fixture.clientArgs).toHaveLength(0);
    expect(fixture.natives[0]!.close).toHaveBeenCalledOnce();
    expect(host().close).toHaveBeenCalledOnce();
    expect(fixture.pin).not.toHaveBeenCalled();
  });
  it("closes a failed fresh event helper as well as the original account helper", async () => {
    fixture.openEvents = true;
    fixture.openPort.mockImplementation(async (authority: object) => {
      if (authority === fixture.authorities[1])
        throw new Error("FIXTURE_EVENT_DENIED");
      return {};
    });
    await runBrowserHost(args());
    expect(fixture.natives).toHaveLength(2);
    expect(fixture.natives[1]!.close).toHaveBeenCalledOnce();
    expect(fixture.natives[0]!.close).toHaveBeenCalledOnce();
    expect(fixture.clientClose).toHaveBeenCalledOnce();
    expect(host().close).toHaveBeenCalledOnce();
    expect(fixture.pin).not.toHaveBeenCalled();
  });
  it("retains strict frame EOF failure and cleans every opened service/helper", async () => {
    Object.assign(fakeProcess, { stdin: Readable.from([Buffer.from([1, 0])]) });
    await expect(runBrowserHost(args())).rejects.toThrow("FRAME_TRUNCATED");
    expect(fixture.serviceCommand).not.toHaveBeenCalled();
    expect(fixture.serviceClose).toHaveBeenCalledOnce();
    expect(fixture.natives[0]!.close).toHaveBeenCalledOnce();
    expect(host().close).toHaveBeenCalledOnce();
  });
  it("retains Store service and helper retirement failures while still closing the Host", async () => {
    const serviceFailure = new Error("FIXTURE_ACCOUNT_CLEANUP_UNKNOWN");
    fixture.serviceClose.mockRejectedValue(serviceFailure);
    fixture.borrowNative.mockImplementation((authority: object) => {
      const native = fixture.natives[fixture.authorities.indexOf(authority)]!;
      native.close.mockRejectedValue(new Error("FIXTURE_HELPER_CLOSE_UNKNOWN"));
      return native;
    });
    const failure = await runBrowserHost(args()).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe(
      "BROWSER_CLEANUP_UNCONFIRMED",
    );
    expect((failure as AggregateError).errors).toContain(serviceFailure);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect(fixture.natives[0]!.close).toHaveBeenCalledOnce();
    expect(host().close).toHaveBeenCalledOnce();
  });
  it("retains original frame failure when subsequent Store cleanup also fails", async () => {
    Object.assign(fakeProcess, { stdin: Readable.from([Buffer.from([1, 0])]) });
    fixture.serviceClose.mockRejectedValue(
      new Error("FIXTURE_CLEANUP_UNKNOWN"),
    );
    const failure = await runBrowserHost(args()).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    expect(
      (failure as AggregateError).errors.map((error: Error) => error.message),
    ).toEqual(["FRAME_TRUNCATED", "FIXTURE_CLEANUP_UNKNOWN"]);
    expect(host().close).toHaveBeenCalledOnce();
  });
  it("reports failed account retirement after Store account setup failure", async () => {
    fixture.connectFailure = new Error("FIXTURE_CONNECT_DENIED");
    const failure = new Error("FIXTURE_ACCOUNT_CLEANUP_UNKNOWN");
    fixture.clientClose.mockRejectedValue(failure);
    await expect(runBrowserHost(args())).rejects.toMatchObject({
      message: "BROWSER_CLEANUP_UNCONFIRMED",
      errors: [failure],
    });
    expect(fixture.clientClose).toHaveBeenCalledOnce();
    expect(fixture.natives[0]!.close).toHaveBeenCalledOnce();
    expect(host().close).toHaveBeenCalledOnce();
  });
  it("preserves the independent legacy four-argument path when no Store authority exists", async () => {
    Object.assign(fakeProcess, { windowsStore: false });
    host().storeAuthority = undefined;
    await runBrowserHost(args().slice(0, 4));
    expect(fixture.pin).toHaveBeenCalledWith(resources);
    expect(fixture.openPort).not.toHaveBeenCalled();
    expect(fixture.lookup).not.toHaveBeenCalled();
    expect(fixture.clientArgs[0]![0]).toBe(fixture.natives[0]);
    expect(fixture.clientArgs[0]![1]).toEqual(
      await fixture.pin.mock.results[0]!.value,
    );
    expect(host().close).toHaveBeenCalledOnce();
  });
});
