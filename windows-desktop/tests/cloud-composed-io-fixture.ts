import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, vi } from "vitest";
import type { AccountSocket } from "../../chrome-extension/src/companion/account-realtime.js";
import { FULL_TIMELINE_RECIPE_DIGEST } from "../../chrome-extension/src/companion/cloud-provider.js";
import {
  AccountController,
  type AccountSessionScope,
  type StoredCredential,
} from "../src/main/account/account-controller.js";
import { createCloudApi } from "../src/main/cloud/api.js";
import { CloudController } from "../src/main/cloud/controller.js";
import { WindowsCloudMedia } from "../src/main/cloud/media.js";
import { FileCapabilities } from "../src/main/file-capabilities.js";
import { createWindowsLibrary } from "../src/main/library/factory.js";
import { libraryNamespace } from "../src/main/library/store.js";
import { UserRealtimeController } from "../src/main/realtime/user-realtime.js";
import { AccountUsageController } from "../src/main/usage/account-usage.js";
import { processingPolicy, processingUsage } from "./realtime-fixtures.js";
import { storageFixture } from "./storage-fixtures.js";
import { libraryArtifactNativeFixture } from "./library-artifact-native-fixture.js";
import { libraryTreeNativeFixture } from "./library-tree-native-fixture.js";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Controlled raw frames, not a replacement for AccountRealtimeClient. */
export class ComposedCloudSocket implements AccountSocket {
  readyState = 1 as const;
  onmessage: WebSocket["onmessage"] = null;
  onclose: WebSocket["onclose"] = null;
  onerror: WebSocket["onerror"] = null;
  send = vi.fn<(value: string) => void>();
  close = vi.fn();
  private readonly sequences = new Map<string, number>();
  constructor(readonly stream: string) {}
  frame(value: unknown) {
    this.onmessage?.call(
      this as unknown as WebSocket,
      { data: JSON.stringify(value) } as MessageEvent,
    );
  }
  ready() {
    this.frame({ type: "ready", protocol_version: 1, stream_id: this.stream });
  }
  controls() {
    return this.send.mock.calls.map(
      ([value]) =>
        JSON.parse(value) as {
          type: string;
          subscription_id: string;
          resource?: string;
          params?: Record<string, string>;
        },
    );
  }
  subscription(resource: string, id?: string) {
    return this.controls().findLast(
      (frame) =>
        frame.type === "subscribe" &&
        frame.resource === resource &&
        (id === undefined || frame.params?.id === id),
    )?.subscription_id;
  }
  snapshot(resource: string, data: unknown, id?: string) {
    const subscription = this.subscription(resource, id);
    if (!subscription) throw new Error(`No ${resource} subscription`);
    const sequence = (this.sequences.get(subscription) ?? 0) + 1;
    this.sequences.set(subscription, sequence);
    this.frame({
      type: "snapshot",
      protocol_version: 1,
      stream_id: this.stream,
      subscription_id: subscription,
      sequence,
      data,
    });
  }
}

const origin = "https://api.example.test",
  project = "musicmute-fixture",
  mediaOrigin = "https://fixture.r2.cloudflarestorage.com",
  videoId = "bZxrIoCPsOc";
const hash = (value: Buffer) =>
  createHash("sha256").update(value).digest("base64");
function jwt(uid: string) {
  return `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(
    JSON.stringify({
      aud: project,
      iss: `https://securetoken.google.com/${project}`,
      sub: uid,
    }),
  ).toString("base64url")}.synthetic-signature`;
}
const uidFrom = (init: RequestInit) => {
  const token = new Headers(init.headers).get("Authorization")?.slice(7);
  if (!token) throw new Error("Fixture backend request lacks bearer");
  return (
    JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as {
      sub: string;
    }
  ).sub;
};

/** Real domain controllers; only Firebase/API/R2/socket/native codec I/O is injected. */
export async function cloudComposedIoFixture() {
  const storage = await storageFixture(),
    installationId = storage.host.report.installationId,
    source = join(storage.root, "unchanged-user-source.wav"),
    original = Buffer.from(
      "synthetic user-selected source; no real codec runs",
    ),
    prepared = Buffer.from("bounded prepared AAC fixture bytes"),
    voice = Buffer.from("bounded voice MP3 fixture bytes"),
    jobId = "0123456789abcdef01234567",
    importId = "0123456789abcdef01234568",
    sockets: ComposedCloudSocket[] = [],
    calls: { url: URL; init: RequestInit; body: Record<string, unknown> }[] =
      [],
    uploaded: Buffer[] = [];
  // Real private WAL/FD births and the actually held cache lease back this
  // portable receiver. No missing Native method is replaced with success.
  const acknowledgeOther =
    storage.native.acknowledgeStorageCleanup.getMockImplementation()!;
  Object.assign(
    storage.native,
    libraryArtifactNativeFixture({
      path: (relative) => join(storage.root, relative.replaceAll("\\", "/")),
      cacheHeld: storage.cacheHeld,
      currentProcess: storage.processIdentity,
      acknowledgeOther,
    }),
    libraryTreeNativeFixture({
      path: (relative) => join(storage.root, relative.replaceAll("\\", "/")),
      cacheHeld: storage.cacheHeld,
    }),
  );
  await writeFile(source, original);
  let requestId: string | undefined,
    sourceKind: "url" | "file" = "url",
    stored: StoredCredential | null = null,
    signedOut = false,
    outputResponse: (() => Promise<Response>) | undefined;
  const input = {
      extension: "m4a",
      content_type: "audio/mp4",
      bytes: prepared.length,
      duration_seconds: 60,
      sha256: hash(prepared),
    },
    expires = () => new Date(Date.now() + 60000).toISOString(),
    voiceResponse = () =>
      new Response(voice, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Length": String(voice.length),
        },
      }),
    fetcher = vi.fn<typeof fetch>(async (raw, init = {}) => {
      const url = new URL(String(raw)),
        body =
          typeof init.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : {};
      calls.push({ url, init, body });
      if (url.hostname === "identitytoolkit.googleapis.com") {
        if (!url.pathname.endsWith(":signInWithPassword"))
          throw new Error("Unexpected Firebase fixture route");
        const uid = String(body.email).startsWith("bob@") ? "bob" : "alice";
        return Response.json({
          localId: uid,
          idToken: jwt(uid),
          refreshToken: `synthetic-refresh-${uid}`,
          expiresIn: "3600",
        });
      }
      if (url.origin === mediaOrigin) {
        if (new Headers(init.headers).has("Authorization"))
          throw new Error("Fixture object transfer received account bearer");
        if (url.pathname === "/input" && init.method === "PUT") {
          const stream = init.body as ReadableStream<Uint8Array>,
            reader = stream.getReader(),
            chunks: Uint8Array[] = [];
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              chunks.push(chunk.value);
            }
          } finally {
            reader.releaseLock();
          }
          uploaded.push(Buffer.concat(chunks));
          return new Response(null, { status: 200 });
        }
        if (url.pathname === "/voice" && init.method === "GET")
          return outputResponse ? outputResponse() : voiceResponse();
        throw new Error("Unexpected object transfer");
      }
      if (url.origin !== origin)
        throw new Error("Unexpected network destination");
      const uid = uidFrom(init);
      if (url.pathname === "/auth/sessions")
        return Response.json({
          user: {
            id: (uid === "bob" ? "b" : "a").repeat(24),
            display_name: uid === "bob" ? "Bob" : "Alice",
            email: `${uid}@example.test`,
            email_verified: true,
            providers: ["password"],
            worker_registration_allowed: false,
          },
          policy: { platforms: { windows: { minimum_build: null } } },
          access: { allowed: true },
        });
      if (url.pathname === "/realtime-tickets")
        return Response.json(
          {
            path: "/realtime/socket",
            protocol: "musicmute.realtime.v1",
            ticket: "t".repeat(43),
            expires_at: new Date(Date.now() + 30000).toISOString(),
          },
          { status: 201 },
        );
      if (url.pathname === "/media-imports") {
        requestId = String(body.request_id);
        sourceKind = "url";
        return Response.json({
          import_id: importId,
          status: "queued",
          job_id: null,
          error: null,
        });
      }
      if (url.pathname === "/jobs" && init.method === "POST") {
        requestId = String(body.request_id);
        sourceKind = "file";
        return Response.json({
          id: jobId,
          request_id: requestId,
          status: "awaiting_upload",
          upload: {
            method: "PUT",
            url: `${mediaOrigin}/input?signature=synthetic`,
            expires_at: expires(),
            headers: {
              "Content-Type": input.content_type,
              "If-None-Match": "*",
              "x-amz-checksum-sha256": input.sha256,
              "x-amz-meta-sha256": input.sha256,
            },
          },
        });
      }
      if (url.pathname === `/jobs/${jobId}/upload-completions`)
        return Response.json({ id: jobId, status: "queued" });
      if (url.pathname === `/jobs/${jobId}/cancellations`)
        return Response.json({ id: jobId, status: "cancel_requested" });
      if (url.pathname === `/jobs/${jobId}/download-grants`)
        return Response.json({
          url: `${mediaOrigin}/voice?signature=synthetic`,
          expires_at: expires(),
        });
      throw new Error(
        `Unexpected backend fixture route: ${init.method} ${url.pathname}`,
      );
    });
  let realtime!: UserRealtimeController,
    library!: ReturnType<typeof createWindowsLibrary>,
    media!: WindowsCloudMedia;
  const scopes: (AccountSessionScope | null)[] = [],
    account = new AccountController({
      configuration: {
        backend_base_url: origin,
        firebase_api_key: "synthetic-firebase-public-api-key",
        firebase_project_id: project,
      },
      installation: {
        installationId,
        appVersion: "0.1.0",
        buildNumber: 1,
        metadataRevision: 1,
        osVersion: "10.0.19045",
      },
      vault: {
        load: async () => stored,
        save: async (credential) => {
          stored = structuredClone(credential);
        },
        remove: async () => {
          stored = null;
        },
      },
      state: {
        readSignedOut: async () => signedOut,
        writeSignedOut: async (value) => {
          signedOut = value;
        },
        publishScope: async (scope) => {
          scopes.push(scope ? { ...scope } : null);
          realtime.setScope(scope);
          await Promise.all([
            library.controller.setScope(scope),
            media.invalidateScope(scope),
          ]);
        },
      },
      google: {
        authorize: async () => {
          throw new Error("Google fixture is unused");
        },
      },
      fetch: (url, init) => fetcher(url, init),
    });
  realtime = new UserRealtimeController({
    origin,
    installationId,
    account,
    fetch: (url, init) => fetcher(url, init),
    socket: (url, protocols) => {
      expect(url).toBe("wss://api.example.test/realtime/socket");
      expect(protocols).toEqual([
        "musicmute.realtime.v1",
        `ticket.${"t".repeat(43)}`,
      ]);
      const socket = new ComposedCloudSocket(`stream-${sockets.length + 1}`);
      sockets.push(socket);
      return socket;
    },
  });
  const usage = new AccountUsageController({ realtime }),
    files = new FileCapabilities(),
    tools = {
      snapshotMediaTools: vi.fn(async () => ({
        releaseRoot: `C:\\owned\\runtime\\releases\\${"a".repeat(64)}`,
        manifestSha256: "b".repeat(64),
        nativeSha256: "c".repeat(64),
        ffmpegPath: "fixed-synthetic-tools",
        ffprobePath: "fixed-synthetic-tools",
      })),
    };
  media = new WindowsCloudMedia({
    host: storage.host,
    tools,
    files,
    fileOwner: "composed-window",
    fetch: fetcher,
    admission: {
      beginWrite: (relative, kind) =>
        storage.controller.beginWrite(relative, kind),
      protectTree: (relative, purpose) =>
        storage.controller.protectTree(relative, purpose),
      reserveScratch: (bytes, relative) =>
        storage.controller.reserveScratch(bytes, relative),
      trackWorkspace: (relative, owner, purpose) =>
        storage.controller.trackWorkspace(relative, owner, purpose),
    },
  });
  let savedMode: "local" | "cloud" = "local";
  const cloud = new CloudController({
    origin,
    installationId,
    account,
    usage,
    realtime,
    media,
    modeStore: {
      read: async () => savedMode,
      write: async (mode) => {
        savedMode = mode;
      },
    },
    localReady: () => false,
    fetch: (url, init) => fetcher(url, init),
  });
  const current = (scope: AccountSessionScope | null) =>
    scope === null ||
    (scope.firebaseUid === account.sessionScope()?.firebaseUid &&
      scope.generation === account.sessionScope()?.generation);
  library = createWindowsLibrary({
    host: storage.host,
    current,
    processIdentity: storage.processIdentity,
    fetch: fetcher,
    consumeResult: (capability, scope) =>
      media.consumeResult(capability, scope),
    controller: {
      scope: () => account.sessionScope(),
      realtime,
      trustedResultMetadata: (capability, scope) =>
        cloud.completedResult(capability, scope),
      request: (scope, path, method, body, signal) =>
        createCloudApi({
          origin,
          installationId,
          account,
          scope,
          fetch: (url, init) => fetcher(url, init),
        }).request(
          {
            firebase_uid: scope.firebaseUid,
            session_generation: scope.generation,
          },
          path,
          method,
          body,
          signal,
        ),
    },
  });
  library.cache.setAdmissionHooks({
    beginWrite: (relative, kind) =>
      storage.controller.beginWrite(relative, kind),
    protectTree: (relative, purpose) =>
      storage.controller.protectTree(relative, purpose),
    reserveVoice: (bytes, relative) =>
      storage.controller.reserveVoice(bytes, relative),
  });
  const adoptions: {
      capability: string;
      scope: AccountSessionScope;
      promise: Promise<void>;
    }[] = [],
    adoptionErrors: unknown[] = [],
    stopAdoption = cloud.subscribe((view) => {
      const scope = account.sessionScope();
      if (
        !scope ||
        view.phase !== "ready" ||
        !view.resultCapability ||
        !view.job ||
        adoptions.some((row) => row.capability === view.resultCapability)
      )
        return;
      const capability = view.resultCapability,
        promise = library.controller
          .adoptCloudResult(capability, view.job.id, scope)
          .catch((error) => {
            adoptionErrors.push(error);
          });
      adoptions.push({ capability, scope: { ...scope }, promise });
    });
  const job = (status = "ready") => ({
    id: jobId,
    request_id: requestId,
    status,
    processing_origin: "cloud",
    source_kind: sourceKind,
    source_url:
      sourceKind === "url"
        ? `https://www.youtube.com/watch?v=${videoId}`
        : null,
    source_title: "Composed fixture voice",
    display_name: null,
    recipe_digest: FULL_TIMELINE_RECIPE_DIGEST,
    trim_enabled: false,
    input,
    output:
      status === "ready"
        ? {
            extension: "mp3",
            content_type: "audio/mpeg",
            bytes: voice.length,
            duration_seconds: 60,
            sha256: hash(voice),
          }
        : null,
    can_download_input: true,
    can_download_output: status === "ready",
    error: null,
  });
  async function signIn(uid: "alice" | "bob") {
    await account.execute({
      type: "SIGN_IN_EMAIL",
      email: `${uid}@example.test`,
      password: "synthetic-password",
    });
    expect(account.view()).toMatchObject({
      state: "signed-in",
      online: true,
      errorCode: null,
    });
    await vi.waitFor(() =>
      expect(sockets).toHaveLength(uid === "alice" ? 1 : 2),
    );
    const socket = sockets.at(-1)!;
    socket.ready();
    socket.snapshot("usage", processingUsage());
    socket.snapshot("policy", processingPolicy());
    socket.snapshot("jobs", { items: [], next_cursor: null });
    await library.controller.flush();
    return { scope: account.sessionScope()!, socket };
  }
  return {
    ...storage,
    source,
    original,
    prepared,
    voice,
    input,
    tools,
    files,
    fetcher,
    calls,
    uploaded,
    account,
    realtime,
    usage,
    media,
    library,
    cloud,
    sockets,
    scopes,
    adoptions,
    adoptionErrors,
    jobId,
    importId,
    videoId,
    job,
    signIn,
    hash,
    setOutputResponse: (next: (() => Promise<Response>) | undefined) => {
      outputResponse = next;
    },
    voiceResponse,
    async accountCatalog(uid: string) {
      return JSON.parse(
        await readFile(
          join(storage.root, "library", libraryNamespace(uid), "catalog.json"),
          "utf8",
        ),
      ) as { ownerUid: string; jobs: { metadata: { id: string } }[] };
    },
    async dispose() {
      stopAdoption();
      await cloud.shutdown();
      await Promise.all(adoptions.map((row) => row.promise));
      library.controller.dispose();
      usage.dispose();
      realtime.dispose();
      await media.dispose();
      await account.shutdown();
    },
  };
}
