import { describe, expect, it, vi } from "vitest";
import {
  AccountController,
  type AccountControllerOptions,
  type StoredCredential,
} from "../src/main/account/account-controller.js";
import { parseAccountCommand } from "../src/shared/account-contracts.js";
import { accountRequest } from "../src/main/account/transport.js";

const config = {
  backend_base_url: "https://api.example.test",
  firebase_api_key: "synthetic-firebase-public-api-key",
  firebase_project_id: "musicmute-fixture",
  google_desktop_client_id: "123-fixture.apps.googleusercontent.com",
};
const installation = {
  installationId: "d7ea7de6-52e9-4b96-8834-3b517941bdb0",
  appVersion: "0.1.0",
  buildNumber: 1,
  metadataRevision: 1,
  osVersion: "10.0.19045",
};
function jwt(uid: string) {
  return `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ aud: config.firebase_project_id, iss: `https://securetoken.google.com/${config.firebase_project_id}`, sub: uid })).toString("base64url")}.synthetic-signature`;
}
function firebase(uid = "alice", expiresIn = "3600") {
  return {
    localId: uid,
    idToken: jwt(uid),
    refreshToken: `synthetic-refresh-token-for-${uid}`,
    expiresIn,
  };
}
function json(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let clock = 1700000000000;
  let stored: StoredCredential | null = null;
  let signedOut = false;
  let providers = ["password", "google.com"];
  let deleting = false;
  let requested = false;
  const calls: {
    url: URL;
    init: RequestInit;
    body: Record<string, unknown>;
  }[] = [];
  const overrides = new Map<string, (init: RequestInit) => Promise<Response>>();
  const user = (uid: string) => ({
    id: (uid === "bob" ? "b" : "a").repeat(24),
    display_name: uid === "bob" ? "Bob" : "Alice",
    email: `${uid}@example.test`,
    email_verified: false,
    providers,
    worker_registration_allowed: true,
    id_token: "must-not-expose",
    firebase_uid: uid,
  });
  const uidFrom = (init: RequestInit) => {
    const token = new Headers(init.headers).get("Authorization")?.slice(7);
    if (!token) return "alice";
    return (
      JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as {
        sub: string;
      }
    ).sub;
  };
  const device = {
    installation_id: installation.installationId,
    platform: "windows",
    app_version: installation.appVersion,
    build_number: 1,
    metadata_revision: 1,
    os_version: installation.osVersion,
    device_model: null,
    last_seen_at: "2026-10-09T00:00:00.000Z",
  };
  const vault = {
    load: vi.fn(async () => stored),
    save: vi.fn(async (value: StoredCredential) => {
      stored = structuredClone(value);
    }),
    remove: vi.fn(async () => {
      stored = null;
    }),
  };
  const state = {
    readSignedOut: vi.fn(async () => signedOut),
    writeSignedOut: vi.fn(async (value: boolean) => {
      signedOut = value;
    }),
    publishScope: vi.fn(async (_scope: unknown) => undefined),
    saveMetadataRevision: vi.fn(async (_revision: number) => undefined),
  };
  const fetcher = vi.fn(async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const body =
      typeof init.body === "string" &&
      new Headers(init.headers).get("Content-Type") === "application/json"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    calls.push({ url, init, body });
    const override = overrides.get(url.pathname);
    if (override) return override(init);
    if (url.host === "identitytoolkit.googleapis.com") {
      const uid =
        typeof body.email === "string" && body.email.startsWith("bob@")
          ? "bob"
          : "alice";
      if (url.pathname.endsWith(":update")) {
        if (Array.isArray(body.deleteProvider)) {
          const removed = body.deleteProvider;
          providers = providers.filter((value) => !removed.includes(value));
        }
        if (body.password) providers = [...new Set([...providers, "password"])];
      }
      return json(firebase(uid));
    }
    if (url.host === "securetoken.googleapis.com")
      return json({
        user_id: "alice",
        id_token: jwt("alice"),
        refresh_token: "synthetic-refreshed-token-for-alice",
        expires_in: "3600",
      });
    if (url.pathname === "/auth/desktop-google-token-exchanges")
      return json({ google_id_token: jwt("google-fixture") });
    if (url.pathname === "/auth/sessions")
      return deleting
        ? json({ code: "ACCOUNT_DELETION_PENDING" }, 403)
        : json({
            user: user(uidFrom(init)),
            policy: { platforms: { windows: { minimum_build: null } } },
            access: { allowed: true },
          });
    if (url.pathname === "/auth/profile-synchronizations")
      return json({ user: { ...user(uidFrom(init)), email_verified: true } });
    if (url.pathname === "/users/me/devices")
      return json({ items: [device], next_cursor: null });
    if (url.pathname === "/users/me" && init.method === "DELETE") {
      deleting = true;
      return json(
        { status: "accepted", recover_until: "2026-10-24T00:00:00.000Z" },
        202,
      );
    }
    if (url.pathname === "/users/me/account-recovery") {
      if (init.method === "POST") requested = true;
      return json({
        account_status: deleting ? "deleting" : "active",
        deletion: deleting
          ? {
              recovery_available: true,
              recover_until: "2026-10-24T00:00:00.000Z",
            }
          : null,
        request: requested ? { status: "pending" } : null,
      });
    }
    if (
      url.pathname === "/auth/session-revocations" ||
      init.method === "DELETE"
    )
      return new Response(null, { status: 204 });
    return json({ status: "accepted" }, 202);
  });
  const google = {
    authorize: vi.fn(async (_client: string, _signal: AbortSignal) => ({
      authorizationCode: "synthetic-google-code",
      codeVerifier: "v".repeat(43),
      redirectUri: "http://127.0.0.1:23456/oauth2callback",
    })),
  };
  const options: AccountControllerOptions = {
    configuration: config,
    installation,
    vault,
    state,
    google,
    fetch: fetcher,
    now: () => clock,
  };
  const controller = new AccountController(options);
  return {
    controller,
    options,
    vault,
    state,
    fetcher,
    google,
    calls,
    overrides,
    device,
    user,
    advance: (ms: number) => {
      clock += ms;
    },
    get stored() {
      return stored;
    },
    setDeleting: (value: boolean) => {
      deleting = value;
    },
    setProviders: (value: string[]) => {
      providers = value;
    },
  };
}
const signIn = (controller: AccountController, email = "alice@example.test") =>
  controller.execute({
    type: "SIGN_IN_EMAIL",
    email,
    password: "synthetic-password",
  });

describe("trusted account workflows", () => {
  it("retires Host, usage and Library scope before deferred persistence and late A cleanup never clears B", async () => {
    const f = fixture();
    await signIn(f.controller);
    const a = f.controller.sessionScope()!;
    f.state.publishScope.mockClear();
    let hostScope: unknown = a,
      usageScope: unknown = a,
      libraryScope: unknown = a,
      finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.state.publishScope.mockImplementation(async (scope) => {
      hostScope = scope;
      usageScope = scope;
      libraryScope = scope;
      if (scope === null) await held;
    });
    f.state.writeSignedOut.mockImplementationOnce(async () => {
      await held;
      throw new Error("fixture tombstone denied");
    });
    const retired = f.controller
      .receiveAuthorizationRejection("UNAUTHENTICATED", a)
      .catch((error) => error);
    expect(hostScope).toBeNull();
    expect(usageScope).toBeNull();
    expect(libraryScope).toBeNull();
    expect(f.controller.activity().busy).toBe(true);
    const loginB = signIn(f.controller, "bob@example.test");
    await vi.waitFor(() =>
      expect(
        f.vault.save.mock.calls.some(
          ([credential]) => credential.firebaseUid === "bob",
        ),
      ).toBe(true),
    );
    expect(hostScope).toBeNull();
    finish();
    expect((await retired).message).toBe("VAULT_UNAVAILABLE");
    await loginB;
    const b = f.controller.sessionScope()!;
    expect(b.firebaseUid).toBe("bob");
    expect(hostScope).toEqual(b);
    expect(usageScope).toEqual(b);
    expect(libraryScope).toEqual(b);
    expect(f.state.publishScope.mock.calls.map(([scope]) => scope)).toEqual([
      null,
      b,
    ]);
    expect(f.stored?.firebaseUid).toBe("bob");
  });
  it("pending deletion retires all consumer scope immediately while retaining recovery persistence behind the same barrier", async () => {
    const f = fixture();
    await signIn(f.controller);
    const a = f.controller.sessionScope()!;
    let hostScope: unknown = a,
      finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.state.publishScope.mockImplementation(async (scope) => {
      hostScope = scope;
    });
    f.vault.save.mockImplementationOnce(async () => {
      await held;
      throw new Error("fixture recovery vault denied");
    });
    const retirement = f.controller.receiveAuthorizationRejection(
      "ACCOUNT_DELETION_PENDING",
      a,
    );
    expect(hostScope).toBeNull();
    expect(f.controller.sessionScope()).toBeNull();
    expect(f.controller.view().state).toBe("deletion-pending");
    expect(f.controller.activity().busy).toBe(true);
    finish();
    await expect(retirement).rejects.toThrow("VAULT_UNAVAILABLE");
    expect(hostScope).toBeNull();
    expect(f.controller.sessionScope()).toBeNull();
    expect(f.controller.activity().busy).toBe(false);
  });
  it("retires only the terminal socket's exact owner and preserves pending-deletion recovery", async () => {
    const f = fixture();
    await signIn(f.controller);
    const original = f.controller.sessionScope()!;
    await expect(
      f.controller.receiveAuthorizationRejection(
        "NETWORK_UNAVAILABLE",
        original,
      ),
    ).rejects.toThrow("MALFORMED_RESPONSE");
    expect(f.controller.sessionScope()).toEqual(original);
    await f.controller.receiveAuthorizationRejection(
      "UNAUTHENTICATED",
      original,
    );
    expect(f.controller.view()).toMatchObject({
      state: "signed-out",
      errorCode: "UNAUTHENTICATED",
      user: null,
    });
    expect(f.controller.sessionScope()).toBeNull();
    expect(f.vault.remove).toHaveBeenCalledOnce();
    expect(f.stored).toBeNull();
    await signIn(f.controller);
    const next = f.controller.sessionScope()!;
    await expect(
      f.controller.receiveAuthorizationRejection("ACCOUNT_DELETED", original),
    ).rejects.toThrow("SESSION_CHANGED");
    expect(f.controller.sessionScope()).toEqual(next);
    await f.controller.receiveAuthorizationRejection(
      "ACCOUNT_DELETION_PENDING",
      next,
    );
    expect(f.controller.view()).toMatchObject({
      state: "deletion-pending",
      errorCode: "ACCOUNT_DELETION_PENDING",
      access: { allowed: false },
    });
    expect(f.controller.sessionScope()).toBeNull();
    expect(f.stored?.deletionPending).toBe(true);
  });
  it("shows retired authority immediately while awaiting durable vault cleanup and never resurrects it on cleanup failure", async () => {
    const f = fixture();
    await signIn(f.controller);
    const scope = f.controller.sessionScope()!;
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.vault.remove.mockImplementationOnce(async () => {
      await held;
      throw new Error("fixture denied vault");
    });
    const task = f.controller.receiveAuthorizationRejection(
      "ACCOUNT_DISABLED",
      scope,
    );
    expect(f.controller.sessionScope()).toBeNull();
    expect(f.controller.view()).toMatchObject({
      state: "signed-out",
      errorCode: "ACCOUNT_DISABLED",
    });
    expect(f.controller.activity().busy).toBe(true);
    let closed = false;
    const shutdown = f.controller.shutdown().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish();
    await expect(task).rejects.toThrow("VAULT_UNAVAILABLE");
    await shutdown;
    expect(closed).toBe(true);
    expect(f.controller.activity().busy).toBe(false);
    expect(f.controller.sessionScope()).toBeNull();
    expect(f.controller.view().user).toBeNull();
  });
  it("keeps a newer global app gate through delayed or legacy policy and later account bootstrap", async () => {
    const f = fixture();
    await signIn(f.controller);
    const next = {
      revision: 5,
      require_verified_email: false,
      platforms: { windows: { minimum_build: 42 } },
    };
    f.controller.receiveAppPolicy(next);
    f.controller.receiveAppPolicy({
      ...next,
      revision: 4,
      platforms: { windows: { minimum_build: null } },
    });
    f.controller.receiveAppPolicy({
      require_verified_email: false,
      platforms: { windows: { minimum_build: null } },
    });
    expect(f.controller.view().minimumBuild).toBe(42);
    expect(f.controller.view().access.reason).toBe("APP_UPDATE_REQUIRED");
    await f.controller.execute({ type: "LOGOUT" });
    await signIn(f.controller);
    expect(f.controller.view().minimumBuild).toBe(42);
    expect(f.controller.view().access.reason).toBe("APP_UPDATE_REQUIRED");
    f.controller.receiveAppPolicy({
      ...next,
      revision: 6,
      platforms: { windows: { minimum_build: null } },
    });
    expect(f.controller.view().access.allowed).toBe(true);
    expect(() =>
      f.controller.receiveAppPolicy({ ...next, revision: -1 }),
    ).toThrow("MALFORMED_RESPONSE");
  });
  it("applies the separate current Windows build/email gate without altering local account-free state", async () => {
    const f = fixture();
    await signIn(f.controller);
    f.controller.receiveAppPolicy({
      require_verified_email: false,
      platforms: { windows: { minimum_build: 2 } },
    });
    expect(f.controller.view().minimumBuild).toBe(2);
    expect(f.controller.view().access.reason).toBe("APP_UPDATE_REQUIRED");
    f.controller.receiveAppPolicy({
      require_verified_email: true,
      platforms: { windows: { minimum_build: null } },
    });
    expect(f.controller.view().access.reason).toBe(
      "EMAIL_VERIFICATION_REQUIRED",
    );
    f.controller.receiveAppPolicy({
      require_verified_email: false,
      platforms: { windows: { minimum_build: null } },
    });
    expect(f.controller.view().access.allowed).toBe(true);
    await f.controller.execute({ type: "LOGOUT" });
    expect(f.controller.view().state).toBe("signed-out");
    expect(() =>
      f.controller.receiveAppPolicy({
        require_verified_email: false,
        platforms: { windows: { minimum_build: 0 } },
      }),
    ).toThrow();
  });
  it("uses Windows session metadata and emits only sanitized presentation data", async () => {
    const f = fixture();
    const views: unknown[] = [];
    f.controller.subscribe((view) => views.push(view));
    const view = await signIn(f.controller);
    expect(view.state).toBe("signed-in");
    expect(view.online).toBe(true);
    expect(view.user?.displayName).toBe("Alice");
    expect(
      f.calls.find((call) => call.url.pathname === "/auth/sessions")?.body,
    ).toMatchObject({
      platform: "windows",
      installation_id: installation.installationId,
      metadata_revision: 1,
    });
    expect(JSON.stringify(views)).not.toContain("synthetic-refresh");
    expect(JSON.stringify(views)).not.toContain(jwt("alice"));
    expect(JSON.stringify(views)).not.toContain("must-not-expose");
    expect(f.stored?.firebaseUid).toBe("alice");
    expect((await f.controller.authorizedSession()).id_token).toBe(
      jwt("alice"),
    );
    const copy = f.controller.view();
    copy.user!.displayName = "Changed";
    expect(f.controller.view().user?.displayName).toBe("Alice");
  });
  it("creates an email account, updates its name, and enforces reset/verification cooldowns", async () => {
    const f = fixture();
    await f.controller.execute({
      type: "SIGN_UP_EMAIL",
      email: "alice@example.test",
      password: "synthetic-password",
      confirmation: "synthetic-password",
      name: "Alice",
    });
    expect(f.calls.some((call) => call.url.pathname.endsWith(":signUp"))).toBe(
      true,
    );
    expect(f.calls.some((call) => call.body.displayName === "Alice")).toBe(
      true,
    );
    await f.controller.execute({ type: "SEND_VERIFICATION" });
    expect(f.controller.view().verificationCooldownSeconds).toBe(60);
    await f.controller.execute({ type: "SEND_VERIFICATION" });
    expect(
      f.calls.filter(
        (call) => call.url.pathname === "/auth/verification-emails",
      ),
    ).toHaveLength(1);
    f.advance(61000);
    await f.controller.execute({ type: "SEND_VERIFICATION" });
    expect(
      f.calls.filter(
        (call) => call.url.pathname === "/auth/verification-emails",
      ),
    ).toHaveLength(2);
    await f.controller.execute({ type: "RECHECK_VERIFICATION" });
    expect(f.controller.view().user?.emailVerified).toBe(true);
    await f.controller.execute({
      type: "RESET_PASSWORD",
      email: "alice@example.test",
    });
    await f.controller.execute({
      type: "RESET_PASSWORD",
      email: "alice@example.test",
    });
    expect(
      f.calls.filter(
        (call) => call.url.pathname === "/auth/password-reset-requests",
      ),
    ).toHaveLength(1);
    expect(f.controller.view().resetCooldownSeconds).toBe(30);
  });
  it("honors server Retry-After without copying upstream error text or secrets", async () => {
    const f = fixture();
    f.overrides.set("/auth/password-reset-requests", async () =>
      json({ code: "RATE_LIMITED", token: "sensitive-test-value" }, 429, {
        "Retry-After": "90",
      }),
    );
    await f.controller.execute({
      type: "RESET_PASSWORD",
      email: "alice@example.test",
    });
    expect(f.controller.view().resetCooldownSeconds).toBe(90);
    expect(f.controller.view().errorCode).toBe("RATE_LIMITED");
    expect(JSON.stringify(f.controller.view())).not.toContain(
      "sensitive-test-value",
    );
  });
  it("Google exchange uses only the approved fixed public route and transient Firebase IdP body", async () => {
    const f = fixture();
    await f.controller.execute({ type: "SIGN_IN_GOOGLE", link: false });
    expect(f.google.authorize).toHaveBeenCalledWith(
      config.google_desktop_client_id,
      expect.any(AbortSignal),
    );
    const exchange = f.calls.find(
      (call) => call.url.pathname === "/auth/desktop-google-token-exchanges",
    )!;
    expect(Object.keys(exchange.body).sort()).toEqual([
      "authorization_code",
      "code_verifier",
      "redirect_uri",
    ]);
    const idp = f.calls.find((call) =>
      call.url.pathname.endsWith(":signInWithIdp"),
    )!;
    expect(idp.body.requestUri).toBe("http://localhost");
    expect(
      new URLSearchParams(String(idp.body.postBody)).get("providerId"),
    ).toBe("google.com");
    expect(idp.body).not.toHaveProperty("idToken");
    expect(JSON.stringify(f.controller.view())).not.toContain(
      "synthetic-google-code",
    );
  });
  it("links passwords/Google and unlinks only with confirmation and a remaining sign-in method", async () => {
    const f = fixture();
    f.setProviders(["google.com"]);
    await signIn(f.controller);
    await f.controller.execute({
      type: "LINK_PASSWORD",
      password: "new-synthetic-password",
      confirmation: "new-synthetic-password",
    });
    expect(f.controller.view().user?.providers).toContain("password");
    await f.controller.execute({ type: "SIGN_IN_GOOGLE", link: true });
    expect(
      f.calls.findLast((call) => call.url.pathname.endsWith(":signInWithIdp"))
        ?.body.idToken,
    ).toBe(jwt("alice"));
    await f.controller.execute({
      type: "UNLINK_PROVIDER",
      provider: "google.com",
      password: "synthetic-password",
      confirmed: true,
    });
    expect(f.controller.view().user?.providers).toEqual(["password"]);
    await f.controller.execute({
      type: "UNLINK_PROVIDER",
      provider: "password",
      password: "synthetic-password",
      confirmed: true,
    });
    expect(f.controller.view().errorCode).toBe("LAST_SIGN_IN_METHOD");
  });
  it("retains the last Windows-supported sign-in method even when an Apple provider from another client is linked", async () => {
    const f = fixture();
    f.setProviders(["password", "apple.com"]);
    await signIn(f.controller);
    const before = f.calls.length;
    await f.controller.execute({
      type: "UNLINK_PROVIDER",
      provider: "password",
      password: "synthetic-password",
      confirmed: true,
    });
    expect(f.controller.view().errorCode).toBe("LAST_SIGN_IN_METHOD");
    expect(f.calls).toHaveLength(before);
    expect(f.controller.view().user?.providers).toEqual([
      "password",
      "apple.com",
    ]);
  });
  it("loads/removes device history and revokes account sessions without touching fleet identity", async () => {
    const f = fixture();
    await signIn(f.controller);
    await f.controller.execute({ type: "LOAD_DEVICES" });
    expect(f.controller.view().devices[0]?.current).toBe(true);
    await f.controller.execute({
      type: "HIDE_DEVICE",
      installationId: installation.installationId,
    });
    expect(f.controller.view().devices).toEqual([]);
    await f.controller.execute({ type: "LOGOUT_ALL", confirmed: true });
    expect(f.controller.view().state).toBe("signed-out");
    expect(f.stored).toBeNull();
    expect(
      f.calls.some((call) => call.url.pathname.startsWith("/worker")),
    ).toBe(false);
  });
  it("deletion immediately fences account capabilities and retains only the recovery credential until server approval", async () => {
    const f = fixture();
    await signIn(f.controller);
    const old = f.controller.sessionScope()!;
    await f.controller.execute({
      type: "DELETE_ACCOUNT",
      password: "synthetic-password",
      confirmed: true,
    });
    expect(f.controller.view().state).toBe("deletion-pending");
    expect(f.controller.view().recovery?.recoveryAvailable).toBe(true);
    expect(f.controller.sessionScope()).toBeNull();
    expect(() => f.controller.assertScope(old)).toThrow("SESSION_CHANGED");
    await expect(f.controller.authorizedSession()).rejects.toMatchObject({
      code: "ACCOUNT_DELETION_PENDING",
    });
    await f.controller.execute({ type: "REQUEST_RECOVERY" });
    expect(f.controller.view().recovery?.requestStatus).toBe("pending");
    expect(f.controller.view().state).toBe("deletion-pending");
    f.setDeleting(false);
    await f.controller.execute({ type: "LOAD_RECOVERY" });
    expect(f.controller.view().state).toBe("signed-in");
    expect(f.controller.sessionScope()).not.toBeNull();
  });
  it("restores cached identity offline, and signed-out tombstones prevent stale vault resurrection", async () => {
    const f = fixture();
    await signIn(f.controller);
    const offline = new AccountController({
      ...f.options,
      fetch: async () => {
        throw new Error("synthetic-network-failure");
      },
    });
    await offline.execute({ type: "RESTORE" });
    expect(offline.view().state).toBe("signed-in");
    expect(offline.view().online).toBe(false);
    expect(offline.view().errorCode).toBe("NETWORK_UNAVAILABLE");
    f.vault.remove.mockRejectedValueOnce(new Error("synthetic-vault-failure"));
    await offline.execute({ type: "LOGOUT" });
    expect(offline.view().state).toBe("signed-out");
    expect(offline.view().errorCode).toBe("VAULT_UNAVAILABLE");
    f.vault.load.mockClear();
    const restored = new AccountController(f.options);
    await restored.execute({ type: "RESTORE" });
    expect(restored.view().state).toBe("signed-out");
    expect(f.vault.load).not.toHaveBeenCalled();
  });
  it("a locked/unavailable vault leaves local processing independent and never leaks native exception data", async () => {
    const f = fixture();
    f.vault.load.mockRejectedValueOnce(
      new Error("native-sensitive-fixture-detail"),
    );
    await f.controller.execute({ type: "RESTORE" });
    expect(f.controller.view().errorCode).toBe("VAULT_UNAVAILABLE");
    expect(f.controller.view().state).toBe("signed-out");
    expect(JSON.stringify(f.controller.view())).not.toContain(
      "native-sensitive",
    );
  });
  it("recovers one device metadata conflict through owned pagination and persists the next revision", async () => {
    const f = fixture();
    let bootstrap = 0;
    f.overrides.set("/auth/sessions", async () =>
      ++bootstrap === 1
        ? json({ code: "DEVICE_REPORT_CONFLICT" }, 409)
        : json({
            user: f.user("alice"),
            policy: { platforms: { windows: { minimum_build: 2 } } },
            access: { allowed: false, reason: "APP_UPDATE_REQUIRED" },
          }),
    );
    f.overrides.set("/users/me/devices", async () =>
      json({
        items: [{ ...f.device, metadata_revision: 7 }],
        next_cursor: null,
      }),
    );
    await signIn(f.controller);
    expect(f.state.saveMetadataRevision).toHaveBeenCalledWith(8);
    expect(
      f.calls.filter((call) => call.url.pathname === "/auth/sessions")[1]?.body
        .metadata_revision,
    ).toBe(8);
    expect(f.controller.view().minimumBuild).toBe(2);
    expect(f.controller.view().access.reason).toBe("APP_UPDATE_REQUIRED");
  });
  it.each([
    {
      fault: "foreign platform",
      device: { platform: "android" },
      code: "DEVICE_REPORT_CONFLICT",
    },
    {
      fault: "exhausted revision",
      device: { metadata_revision: Number.MAX_SAFE_INTEGER - 1 },
      code: "DEVICE_REPORT_CONFLICT",
    },
    {
      fault: "corrupt revision",
      device: { metadata_revision: "7" },
      code: "MALFORMED_RESPONSE",
    },
  ])(
    "device conflict cannot publish or retry auth after $fault",
    async ({ device, code }) => {
      const f = fixture();
      f.overrides.set("/auth/sessions", async () =>
        json({ code: "DEVICE_REPORT_CONFLICT" }, 409),
      );
      f.overrides.set("/users/me/devices", async () =>
        json({ items: [{ ...f.device, ...device }], next_cursor: null }),
      );
      await signIn(f.controller);
      expect(f.controller.view().errorCode).toBe(code);
      expect(f.controller.sessionScope()).toBeNull();
      expect(f.state.saveMetadataRevision).not.toHaveBeenCalled();
      expect(f.vault.save).not.toHaveBeenCalled();
      expect(
        f.calls.filter((call) => call.url.pathname === "/auth/sessions"),
      ).toHaveLength(1);
    },
  );
  it("device conflict pagination refuses a repeated cursor without persisting a guessed revision", async () => {
    const f = fixture();
    f.overrides.set("/auth/sessions", async () =>
      json({ code: "DEVICE_REPORT_CONFLICT" }, 409),
    );
    f.overrides.set("/users/me/devices", async () =>
      json({ items: [], next_cursor: "a".repeat(24) }),
    );
    await signIn(f.controller);
    expect(f.controller.view().errorCode).toBe("DEVICE_REPORT_CONFLICT");
    const pages = f.calls.filter(
      (call) => call.url.pathname === "/users/me/devices",
    );
    expect(pages).toHaveLength(2);
    expect(pages[1]!.url.searchParams.get("before")).toBe("a".repeat(24));
    expect(f.state.saveMetadataRevision).not.toHaveBeenCalled();
    expect(f.vault.save).not.toHaveBeenCalled();
  });
  it("cancelled prospective-owner device repair cannot persist A or retry its session after B is accepted", async () => {
    const f = fixture(),
      reply = deferred<Response>();
    f.overrides.set("/auth/sessions", async () =>
      json({ code: "DEVICE_REPORT_CONFLICT" }, 409),
    );
    f.overrides.set("/users/me/devices", async () => reply.promise);
    const loginA = signIn(f.controller);
    await vi.waitFor(() =>
      expect(
        f.calls.some((call) => call.url.pathname === "/users/me/devices"),
      ).toBe(true),
    );
    await f.controller.execute({ type: "LOGOUT" });
    f.overrides.delete("/auth/sessions");
    f.overrides.delete("/users/me/devices");
    await signIn(f.controller, "bob@example.test");
    reply.resolve(
      json({
        items: [{ ...f.device, metadata_revision: 42 }],
        next_cursor: null,
      }),
    );
    await loginA;
    expect(f.controller.sessionScope()?.firebaseUid).toBe("bob");
    expect(f.stored?.firebaseUid).toBe("bob");
    expect(f.state.saveMetadataRevision).not.toHaveBeenCalled();
    expect(
      f.calls.filter((call) => call.url.pathname === "/auth/sessions"),
    ).toHaveLength(2);
    expect(
      f.vault.save.mock.calls.every(([value]) => value.firebaseUid === "bob"),
    ).toBe(true);
  });
});

describe("account generation and transport fences", () => {
  it.each(
    ["DELETE_ACCOUNT", "LOGOUT_ALL", "UNLINK_PROVIDER"].flatMap((type) =>
      ["bob@example.test", "alice@example.test"].map((email) => ({
        type,
        email,
      })),
    ),
  )(
    "old $type consent cannot affect $email after logout/login",
    async ({ type, email }) => {
      const f = fixture();
      await signIn(f.controller);
      const reviewed = f.controller.view().destructiveReview!;
      expect(reviewed.accountId).toBe("a".repeat(24));
      await f.controller.execute({ type: "LOGOUT" });
      await signIn(f.controller, email);
      const requests = f.calls.length,
        saved = f.vault.save.mock.calls.length;
      const command = {
        type,
        confirmed: true,
        expectedAccountId: reviewed.accountId,
        expectedSessionGeneration: reviewed.generation,
        ...(type !== "LOGOUT_ALL" ? { password: "synthetic-password" } : {}),
        ...(type === "UNLINK_PROVIDER" ? { provider: "google.com" } : {}),
      };
      await f.controller.execute(command);
      expect(f.controller.view().errorCode).toBe("SESSION_CHANGED");
      expect(f.calls).toHaveLength(requests);
      expect(f.google.authorize).not.toHaveBeenCalled();
      expect(f.vault.save).toHaveBeenCalledTimes(saved);
      expect(f.controller.sessionScope()?.firebaseUid).toBe(
        email.startsWith("bob") ? "bob" : "alice",
      );
    },
  );
  it("requires a complete closed review pair while preserving omitted trusted internal commands", () => {
    const review = {
        expectedAccountId: "a".repeat(24),
        expectedSessionGeneration: "00000000-0000-4000-8000-000000000001",
      },
      base = { type: "LOGOUT_ALL", confirmed: true };
    expect(parseAccountCommand(base)).toEqual(base);
    expect(parseAccountCommand({ ...base, ...review })).toEqual({
      ...base,
      ...review,
    });
    for (const command of [
      { ...base, expectedAccountId: review.expectedAccountId },
      { ...base, expectedSessionGeneration: review.expectedSessionGeneration },
      { ...base, ...review, expectedAccountId: "foreign" },
      { ...base, ...review, expectedSessionGeneration: "old" },
      { type: "RECONNECT", ...review },
    ])
      expect(() => parseAccountCommand(command)).toThrow("INVALID_INPUT");
  });
  it("applies worker registration only to the current owner generation", async () => {
    const f = fixture();
    await signIn(f.controller);
    const scopeA = f.controller.sessionScope()!;
    f.controller.receiveWorkerRegistration(
      { worker_registration_allowed: true, internal_secret: "not selected" },
      scopeA,
    );
    expect(f.controller.view().user?.workerRegistrationAllowed).toBe(true);
    expect(JSON.stringify(f.controller.view())).not.toContain("not selected");
    await f.controller.execute({ type: "LOGOUT" });
    await signIn(f.controller, "bob@example.test");
    expect(() =>
      f.controller.receiveWorkerRegistration(
        { worker_registration_allowed: true },
        scopeA,
      ),
    ).toThrow("SESSION_CHANGED");
    const scopeB = f.controller.sessionScope()!;
    f.controller.receiveWorkerRegistration(
      { worker_registration_allowed: false },
      scopeB,
    );
    expect(f.controller.view().user?.workerRegistrationAllowed).toBe(false);
    expect(() =>
      f.controller.receiveWorkerRegistration(
        { worker_registration_allowed: "yes" },
        scopeB,
      ),
    ).toThrow("MALFORMED_RESPONSE");
  });

  it("serializes slow old-account vault writes before sign-out cleanup and a new account save", async () => {
    const f = fixture();
    await signIn(f.controller);
    const pendingWrite = deferred<void>();
    const originalSave = f.vault.save.getMockImplementation()!;
    f.vault.save.mockImplementationOnce(async (value) => {
      await pendingWrite.promise;
      await originalSave(value);
    });
    const refresh = f.controller.authorization(true).catch(() => undefined);
    await vi.waitFor(() => expect(f.vault.save).toHaveBeenCalledTimes(2));
    const logout = f.controller.execute({ type: "LOGOUT" });
    const loginB = signIn(f.controller, "bob@example.test");
    pendingWrite.resolve();
    await Promise.all([refresh, logout, loginB]);
    expect(f.controller.view().user?.displayName).toBe("Bob");
    expect(f.stored?.firebaseUid).toBe("bob");
    const reopened = new AccountController(f.options);
    await reopened.execute({ type: "RESTORE" });
    expect(reopened.view().user?.displayName).toBe("Bob");
  });
  it("revoked refresh credentials clear the session and persist the sign-out tombstone", async () => {
    const f = fixture();
    await signIn(f.controller);
    f.advance(3600000);
    f.overrides.set("/v1/token", async () =>
      json({ error: { message: "INVALID_REFRESH_TOKEN" } }, 400),
    );
    await f.controller.execute({ type: "RECONNECT" });
    expect(f.controller.view().state).toBe("signed-out");
    expect(f.stored).toBeNull();
    f.vault.load.mockClear();
    await new AccountController(f.options).execute({ type: "RESTORE" });
    expect(f.vault.load).not.toHaveBeenCalled();
  });
  it("restores pending deletion for recovery and preserves a committed deletion when the recovery read goes offline", async () => {
    const f = fixture();
    await signIn(f.controller);
    f.overrides.set("/users/me/account-recovery", async () => {
      throw new Error("offline");
    });
    await f.controller.execute({
      type: "DELETE_ACCOUNT",
      password: "synthetic-password",
      confirmed: true,
    });
    expect(f.controller.view().state).toBe("deletion-pending");
    expect(f.stored?.deletionPending).toBe(true);
    expect(f.controller.sessionScope()).toBeNull();
    f.overrides.delete("/users/me/account-recovery");
    const restored = new AccountController(f.options);
    await restored.execute({ type: "RESTORE" });
    expect(restored.view().state).toBe("deletion-pending");
    expect(restored.view().recovery?.recoveryAvailable).toBe(true);
  });
  it("quit disposal cancels browser work and fences capabilities while preserving the saved account", async () => {
    const f = fixture();
    await signIn(f.controller);
    const fence = f.controller.captureOwnerFence();
    const late = deferred<{
      authorizationCode: string;
      codeVerifier: string;
      redirectUri: string;
    }>();
    f.google.authorize.mockImplementation(async () => late.promise);
    const pending = f.controller.execute({
      type: "SIGN_IN_GOOGLE",
      link: true,
    });
    await vi.waitFor(() => expect(f.google.authorize).toHaveBeenCalledOnce());
    f.controller.dispose();
    late.resolve({
      authorizationCode: "late",
      codeVerifier: "v".repeat(43),
      redirectUri: "http://127.0.0.1:23456/oauth2callback",
    });
    await pending;
    expect(() => fence()).toThrow("SESSION_CHANGED");
    expect(f.controller.sessionScope()).toBeNull();
    await expect(f.controller.authorization()).rejects.toMatchObject({
      code: "SESSION_CHANGED",
    });
    expect(f.stored?.firebaseUid).toBe("alice");
    expect(f.vault.remove).not.toHaveBeenCalled();
  });
  it("rejects late login A after sign-out and login B even when a transport ignores cancellation", async () => {
    const f = fixture();
    const late = deferred<Response>();
    let signins = 0;
    f.overrides.set("/v1/accounts:signInWithPassword", async () =>
      ++signins === 1 ? late.promise : json(firebase("bob")),
    );
    const pending = signIn(f.controller);
    await vi.waitFor(() => expect(signins).toBe(1));
    await f.controller.execute({ type: "LOGOUT" });
    await signIn(f.controller, "bob@example.test");
    late.resolve(json(firebase("alice")));
    await pending;
    expect(f.controller.view().user?.displayName).toBe("Bob");
    expect(f.stored?.firebaseUid).toBe("bob");
    expect(
      f.vault.save.mock.calls.some(([value]) => value.firebaseUid === "alice"),
    ).toBe(false);
  });
  it("does not expose late device/account data after an owner switch", async () => {
    const f = fixture();
    await signIn(f.controller);
    const late = deferred<Response>();
    f.overrides.set("/users/me/devices", async () => late.promise);
    const pending = f.controller.execute({ type: "LOAD_DEVICES" });
    await vi.waitFor(() =>
      expect(
        f.calls.some((call) => call.url.pathname === "/users/me/devices"),
      ).toBe(true),
    );
    await f.controller.execute({ type: "LOGOUT" });
    await signIn(f.controller, "bob@example.test");
    late.resolve(json({ items: [f.device], next_cursor: null }));
    await pending;
    expect(f.controller.view().user?.displayName).toBe("Bob");
    expect(f.controller.view().devices).toEqual([]);
  });
  it("deduplicates refresh, fences revoked credentials, and never retries mutations after unauthenticated failure", async () => {
    const f = fixture();
    await signIn(f.controller);
    f.advance(3600000);
    await Promise.all([
      f.controller.authorization(),
      f.controller.authorization(),
    ]);
    expect(
      f.calls.filter((call) => call.url.host === "securetoken.googleapis.com"),
    ).toHaveLength(1);
    f.overrides.set("/auth/verification-emails", async () =>
      json({ code: "UNAUTHENTICATED" }, 401),
    );
    await f.controller.execute({ type: "SEND_VERIFICATION" });
    expect(
      f.calls.filter(
        (call) => call.url.pathname === "/auth/verification-emails",
      ),
    ).toHaveLength(1);
    expect(f.controller.view().state).toBe("signed-out");
  });
  it("cancels Google before exchange and rejects attacker-selected command URLs/tokens", async () => {
    const f = fixture();
    const late = deferred<{
      authorizationCode: string;
      codeVerifier: string;
      redirectUri: string;
    }>();
    f.google.authorize.mockImplementation(async () => late.promise);
    const pending = f.controller.execute({
      type: "SIGN_IN_GOOGLE",
      link: false,
    });
    await vi.waitFor(() => expect(f.google.authorize).toHaveBeenCalledOnce());
    await f.controller.execute({ type: "CANCEL_SIGN_IN" });
    late.resolve({
      authorizationCode: "old-code",
      codeVerifier: "v".repeat(43),
      redirectUri: "http://127.0.0.1:23456/oauth2callback",
    });
    await pending;
    expect(f.controller.view().state).toBe("signed-out");
    expect(f.calls).toHaveLength(0);
    for (const command of [
      { type: "SIGN_IN_GOOGLE", link: false, clientId: "attacker" },
      { type: "RESTORE", token: "attacker" },
      { type: "DELETE_ACCOUNT", password: "fixture", confirmed: false },
      { type: "LOAD_DEVICES", before: "https://attacker.example" },
    ])
      expect(() => parseAccountCommand(command)).toThrow();
  });
  it("counts response bytes and deadlines even for transports that ignore AbortSignal", async () => {
    await expect(
      accountRequest(
        async () => json({ oversized: "x".repeat(50) }),
        "https://api.example.test",
        {},
        { limit: 20 },
      ),
    ).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
    await expect(
      accountRequest(
        async () => new Promise<Response>(() => undefined),
        "https://api.example.test",
        {},
        { deadlineMs: 10 },
      ),
    ).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
    await expect(
      accountRequest(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel: () => new Promise<void>(() => undefined),
            }),
            { headers: { "Content-Type": "application/json" } },
          ),
        "https://api.example.test",
        {},
        { deadlineMs: 10 },
      ),
    ).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
    const malicious = fixture();
    malicious.overrides.set("/auth/password-reset-requests", async () =>
      json({ code: jwt("alice"), message: "sensitive-server-value" }, 400),
    );
    await malicious.controller.execute({
      type: "RESET_PASSWORD",
      email: "alice@example.test",
    });
    expect(malicious.controller.view().errorCode).toBe(
      "ACCOUNT_REQUEST_FAILED",
    );
  });
});
