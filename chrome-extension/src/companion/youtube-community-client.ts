import { randomUUID } from "node:crypto";
import {
  canonicalYouTubeUrl,
  MVP_MAX_DURATION_SECONDS,
  isLocalAudioDeclaration,
  type LocalAudioDeclaration,
} from "../shared/protocol.js";
import { desktopRecord } from "../shared/desktop-protocol.js";
import {
  accountApiOrigin,
  boundedJson,
  DesktopApiError,
} from "./account-api.js";
import {
  validGuestCredential,
  type GuestCredential,
  type GuestCredentialStore,
} from "./guest-credentials.js";

export const YOUTUBE_COMMUNITY_PROFILE = "kim-vocal-2-full-timeline-v1";
const ID = /^[a-f0-9]{24}$/;
const STATES = [
  "preparing",
  "waiting",
  "awaiting_upload",
  "validating",
  "ready",
  "expired",
  "rejected",
  "failed",
];
export interface CommunityArtifact {
  declaration: LocalAudioDeclaration;
  grant: { url: string; expires_at: string };
}
export interface CommunityDelivery {
  video_id: string;
  profile_id: typeof YOUTUBE_COMMUNITY_PROFILE;
  provenance: "trusted" | "community_contributed";
  source_identity_verified: boolean;
  original: CommunityArtifact;
  vocals: CommunityArtifact;
}
export interface CommunityContribution {
  contribution_id: string | null;
  request_id: string;
  video_id: string;
  profile_id: typeof YOUTUBE_COMMUNITY_PROFILE;
  state: string;
  producer: boolean;
  expires_at: string | null;
  lease_expires_at: string | null;
  upload_grants: { original: unknown; vocals: unknown } | null;
}
export type CommunitySocket = Pick<
  WebSocket,
  | "readyState"
  | "send"
  | "close"
  | "onopen"
  | "onmessage"
  | "onclose"
  | "onerror"
>;
export function communityDeclaration(value: unknown): LocalAudioDeclaration {
  if (
    !desktopRecord(value) ||
    typeof value.sha256 !== "string" ||
    !/^[A-Za-z0-9+/]{43}=$/.test(value.sha256) ||
    Buffer.from(value.sha256, "base64").toString("base64") !== value.sha256
  )
    throw new DesktopApiError("COMMUNITY_REPLY_INVALID");
  const result = {
    ...value,
    sha256: Buffer.from(value.sha256, "base64").toString("hex"),
  };
  if (
    !isLocalAudioDeclaration(result) ||
    result.duration_seconds > MVP_MAX_DURATION_SECONDS ||
    result.bytes > 100_000_000
  )
    throw new DesktopApiError("COMMUNITY_REPLY_INVALID");
  return result;
}
export function communityWireDeclaration(item: LocalAudioDeclaration) {
  if (!isLocalAudioDeclaration(item))
    throw new DesktopApiError("COMMUNITY_ARTIFACT_INVALID");
  return {
    ...item,
    sha256: Buffer.from(item.sha256, "hex").toString("base64"),
  };
}
function artifact(value: unknown): CommunityArtifact {
  if (
    !desktopRecord(value) ||
    !desktopRecord(value.grant) ||
    typeof value.grant.url !== "string" ||
    value.grant.url.length > 8192 ||
    typeof value.grant.expires_at !== "string"
  )
    throw new DesktopApiError("COMMUNITY_REPLY_INVALID");
  let target: URL;
  try {
    target = new URL(value.grant.url);
  } catch {
    throw new DesktopApiError("COMMUNITY_GRANT_INVALID");
  }
  const expiry = Date.parse(value.grant.expires_at);
  if (
    target.protocol !== "https:" ||
    target.port ||
    target.username ||
    target.password ||
    target.hash ||
    !/^[a-z0-9-]+\.r2\.cloudflarestorage\.com$/.test(target.hostname) ||
    !Number.isFinite(expiry) ||
    expiry <= Date.now() ||
    expiry > Date.now() + 630_000
  )
    throw new DesktopApiError("COMMUNITY_GRANT_INVALID");
  return {
    declaration: communityDeclaration(value.declaration),
    grant: { url: value.grant.url, expires_at: value.grant.expires_at },
  };
}
export function parseCommunityDelivery(
  value: unknown,
  videoId: string,
  duration?: number,
): CommunityDelivery {
  if (
    !desktopRecord(value) ||
    value.video_id !== videoId ||
    value.profile_id !== YOUTUBE_COMMUNITY_PROFILE ||
    !["trusted", "community_contributed"].includes(String(value.provenance)) ||
    typeof value.source_identity_verified !== "boolean"
  )
    throw new DesktopApiError("COMMUNITY_REPLY_INVALID");
  const original = artifact(value.original),
    vocals = artifact(value.vocals);
  if (
    vocals.declaration.extension !== "mp3" ||
    vocals.declaration.content_type !== "audio/mpeg" ||
    (duration !== undefined &&
      Math.abs(original.declaration.duration_seconds - duration) > 2) ||
    Math.abs(
      original.declaration.duration_seconds -
        vocals.declaration.duration_seconds,
    ) > 0.25
  )
    throw new DesktopApiError("TIMELINE_MISMATCH");
  return {
    video_id: videoId,
    profile_id: YOUTUBE_COMMUNITY_PROFILE,
    provenance: value.provenance as CommunityDelivery["provenance"],
    source_identity_verified: value.source_identity_verified,
    original,
    vocals,
  };
}
function contribution(
  value: unknown,
  videoId: string,
  requestId?: string,
): CommunityContribution {
  if (
    !desktopRecord(value) ||
    !(
      ID.test(String(value.contribution_id)) ||
      (value.contribution_id === null &&
        value.state === "ready" &&
        value.producer === false)
    ) ||
    typeof value.request_id !== "string" ||
    (requestId !== undefined && value.request_id !== requestId) ||
    value.video_id !== videoId ||
    value.profile_id !== YOUTUBE_COMMUNITY_PROFILE ||
    !STATES.includes(String(value.state)) ||
    typeof value.producer !== "boolean" ||
    !(
      (value.expires_at === null && value.state === "ready") ||
      (typeof value.expires_at === "string" &&
        Number.isFinite(Date.parse(value.expires_at)))
    ) ||
    !(
      value.lease_expires_at === null ||
      (typeof value.lease_expires_at === "string" &&
        Number.isFinite(Date.parse(value.lease_expires_at)))
    ) ||
    !(value.upload_grants === null || desktopRecord(value.upload_grants))
  )
    throw new DesktopApiError("COMMUNITY_REPLY_INVALID");
  return value as unknown as CommunityContribution;
}

/** Installation capability is held in Keychain; account credentials never enter this transport. */
export class YouTubeCommunityClient {
  readonly origin: string;
  private sessionPromise: Promise<GuestCredential> | undefined;
  constructor(
    origin: string,
    private readonly store: GuestCredentialStore,
    private readonly fetcher: typeof fetch = fetch,
    private readonly socketFactory: (url: string) => CommunitySocket = (url) =>
      new WebSocket(url),
  ) {
    this.origin = accountApiOrigin(origin);
  }
  private async session(minimumRemaining = 60_000): Promise<GuestCredential> {
    if (this.sessionPromise) {
      const existing = await this.sessionPromise;
      if (Date.parse(existing.expires_at) > Date.now() + minimumRemaining)
        return existing;
      this.sessionPromise = undefined;
    }
    this.sessionPromise ??= (async () => {
      const current = await this.store.load();
      if (
        current &&
        validGuestCredential(current) &&
        Date.parse(current.expires_at) > Date.now() + minimumRemaining
      )
        return current;
      const reply = await this.fetcher(
        `${this.origin}/youtube-guest-sessions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        },
      ).catch(() => {
        throw new DesktopApiError("COMMUNITY_UNAVAILABLE");
      });
      const next = await boundedJson(reply, 4096);
      if (
        !reply.ok ||
        !validGuestCredential(next) ||
        Date.parse(next.expires_at) <= Date.now() + minimumRemaining
      )
        throw new DesktopApiError(
          "COMMUNITY_SESSION_UNAVAILABLE",
          reply.status,
        );
      await this.store.save(next);
      return next;
    })().catch((error: unknown) => {
      this.sessionPromise = undefined;
      throw error;
    });
    return this.sessionPromise;
  }
  async request(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (
      !/^\/youtube-(?:cache-deliveries|contributions)(?:\/[a-f0-9]{24}\/(?:upload-grants|completions|lease-renewals|source-deliveries|failures))?$/.test(
        path,
      )
    )
      throw new DesktopApiError("INVALID_API_PATH");
    const credential = await this.session();
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized) > 16384)
      throw new DesktopApiError("API_REQUEST_TOO_LARGE");
    let reply: Response;
    try {
      reply = await this.fetcher(`${this.origin}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential.token}`,
          "Content-Type": "application/json",
        },
        body: serialized,
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(180_000)])
          : AbortSignal.timeout(180_000),
      });
    } catch {
      throw new DesktopApiError(
        signal?.aborted ? "CANCELLED" : "COMMUNITY_UNAVAILABLE",
      );
    }
    const value = await boundedJson(reply);
    if (!reply.ok) {
      const code =
        desktopRecord(value) &&
        typeof value.code === "string" &&
        /^[A-Z][A-Z0-9_]{1,63}$/.test(value.code)
          ? value.code
          : "COMMUNITY_REQUEST_FAILED";
      throw new DesktopApiError(code, reply.status);
    }
    return value;
  }
  async lookup(
    videoId: string,
    duration: number | undefined,
    signal?: AbortSignal,
  ): Promise<CommunityDelivery | null> {
    try {
      return parseCommunityDelivery(
        await this.request(
          "/youtube-cache-deliveries",
          { url: canonicalYouTubeUrl(videoId) },
          signal,
        ),
        videoId,
        duration,
      );
    } catch (error) {
      if (
        error instanceof DesktopApiError &&
        error.status === 404 &&
        ["IMPORT_CACHE_MISS", "YOUTUBE_CACHE_MISS"].includes(error.code)
      )
        return null;
      throw error;
    }
  }
  async lookupOriginal(
    view: CommunityContribution,
    duration: number,
    signal: AbortSignal,
  ): Promise<CommunityArtifact | null> {
    if (
      !view.producer ||
      view.state !== "preparing" ||
      !view.contribution_id ||
      !ID.test(view.contribution_id)
    )
      throw new DesktopApiError("COMMUNITY_LEASE_INVALID");
    try {
      const value = await this.request(
        `/youtube-contributions/${view.contribution_id}/source-deliveries`,
        {},
        signal,
      );
      if (
        !desktopRecord(value) ||
        value.video_id !== view.video_id ||
        value.provenance !== "trusted" ||
        value.source_identity_verified !== true
      )
        throw new DesktopApiError("COMMUNITY_REPLY_INVALID");
      const original = artifact(value.original);
      if (Math.abs(original.declaration.duration_seconds - duration) > 2)
        throw new DesktopApiError("TIMELINE_MISMATCH");
      return original;
    } catch (error) {
      if (
        error instanceof DesktopApiError &&
        error.status === 404 &&
        error.code === "IMPORT_CACHE_MISS"
      )
        return null;
      throw error;
    }
  }
  async reserve(
    videoId: string,
    signal: AbortSignal,
    requestId: string = randomUUID(),
  ): Promise<CommunityContribution> {
    await this.session(24 * 60 * 60_000);
    return contribution(
      await this.request(
        "/youtube-contributions",
        {
          request_id: requestId,
          url: canonicalYouTubeUrl(videoId),
          profile_id: YOUTUBE_COMMUNITY_PROFILE,
        },
        signal,
      ),
      videoId,
      requestId,
    );
  }
  async renew(view: CommunityContribution, signal: AbortSignal): Promise<void> {
    const next = contribution(
      await this.request(
        `/youtube-contributions/${view.contribution_id}/lease-renewals`,
        {},
        signal,
      ),
      view.video_id,
      view.request_id,
    );
    if (!next.producer || next.state !== "preparing")
      throw new DesktopApiError("COMMUNITY_LEASE_LOST");
  }
  async fail(view: CommunityContribution): Promise<void> {
    await this.request(
      `/youtube-contributions/${view.contribution_id}/failures`,
      {},
      AbortSignal.timeout(10_000),
    );
  }
  async uploadGrants(
    view: CommunityContribution,
    original: LocalAudioDeclaration,
    vocals: LocalAudioDeclaration,
    signal?: AbortSignal,
  ): Promise<CommunityContribution> {
    return contribution(
      await this.request(
        `/youtube-contributions/${view.contribution_id}/upload-grants`,
        {
          request_id: view.request_id,
          original: communityWireDeclaration(original),
          vocals: communityWireDeclaration(vocals),
        },
        signal,
      ),
      view.video_id,
      view.request_id,
    );
  }
  async complete(
    view: CommunityContribution,
    signal?: AbortSignal,
  ): Promise<CommunityContribution> {
    return contribution(
      await this.request(
        `/youtube-contributions/${view.contribution_id}/completions`,
        {},
        signal,
      ),
      view.video_id,
      view.request_id,
    );
  }
  /** Only full snapshots wake followers; reconnects receive a fresh snapshot and never poll HTTP. */
  async wait(videoId: string, signal: AbortSignal): Promise<"ready" | "retry"> {
    const credential = await this.session();
    return new Promise((resolve, reject) => {
      let socket: CommunitySocket | undefined;
      let retry: ReturnType<typeof setTimeout> | undefined;
      let sequence = -1,
        attempts = 0,
        settled = false;
      const deadline = setTimeout(
        () => finish(new DesktopApiError("COMMUNITY_WAIT_TIMEOUT")),
        20 * 60_000,
      );
      const finish = (error?: Error, value?: "ready" | "retry") => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (retry) clearTimeout(retry);
        signal.removeEventListener("abort", aborted);
        if (socket) {
          socket.onclose = null;
          socket.onmessage = null;
          socket.onerror = null;
          socket.close();
        }
        if (error) reject(error);
        else resolve(value!);
      };
      const aborted = () => finish(new DesktopApiError("CANCELLED"));
      const connect = () => {
        if (signal.aborted) {
          aborted();
          return;
        }
        try {
          socket = this.socketFactory(
            this.origin.replace(/^http/, "ws") + "/youtube-community-realtime",
          );
        } catch {
          finish(new DesktopApiError("COMMUNITY_UNAVAILABLE"));
          return;
        }
        const current = socket;
        current.onopen = () =>
          current.send(
            JSON.stringify({
              type: "authenticate",
              token: credential.token,
              video_id: videoId,
            }),
          );
        current.onmessage = (event) => {
          if (settled || socket !== current) return;
          let value: unknown;
          try {
            if (
              typeof event.data !== "string" ||
              Buffer.byteLength(event.data) > 16384
            )
              throw new Error();
            value = JSON.parse(event.data);
          } catch {
            finish(new DesktopApiError("COMMUNITY_REPLY_INVALID"));
            return;
          }
          if (
            !desktopRecord(value) ||
            value.type !== "snapshot" ||
            value.video_id !== videoId ||
            !Number.isSafeInteger(value.sequence) ||
            Number(value.sequence) < 0 ||
            ![
              "missing",
              "preparing",
              "awaiting_upload",
              "validating",
              "ready",
              "failed",
            ].includes(String(value.state)) ||
            !(
              value.expires_at === null ||
              (typeof value.expires_at === "string" &&
                Number.isFinite(Date.parse(value.expires_at)))
            )
          ) {
            finish(new DesktopApiError("COMMUNITY_REPLY_INVALID"));
            return;
          }
          if (Number(value.sequence) <= sequence) return;
          sequence = Number(value.sequence);
          attempts = 0;
          if (value.state === "ready") finish(undefined, "ready");
          else if (["missing", "failed"].includes(String(value.state)))
            finish(undefined, "retry");
        };
        current.onerror = () => current.close();
        current.onclose = (event) => {
          if (settled || socket !== current) return;
          if (event.code === 1008) {
            finish(new DesktopApiError("COMMUNITY_AUTH_REQUIRED"));
            return;
          }
          sequence = -1;
          retry = setTimeout(
            connect,
            Math.min(10_000, 250 * 2 ** Math.min(attempts++, 6)),
          );
        };
      };
      signal.addEventListener("abort", aborted, { once: true });
      connect();
    });
  }
}
