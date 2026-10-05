import {
  desktopRecord,
  validateDesktopSession,
  type DesktopSession,
} from "../shared/desktop-protocol.js";

export type AccountScope = Pick<
  DesktopSession,
  "firebase_uid" | "session_generation"
>;
export class DesktopApiError extends Error {
  constructor(
    readonly code: string,
    readonly status = 0,
    readonly retry_after_seconds?: number,
  ) {
    super(code);
  }
}
export function sameAccountScope(a: AccountScope, b: AccountScope): boolean {
  return (
    a.firebase_uid === b.firebase_uid &&
    a.session_generation === b.session_generation
  );
}
export function accountApiOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DesktopApiError("INVALID_API_ORIGIN");
  }
  const loopback =
    url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (!loopback && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new DesktopApiError("INVALID_API_ORIGIN");
  return url.origin;
}
function retryAfter(value: string | null): number | undefined {
  if (!value || !/^\d{1,6}$/.test(value)) return undefined;
  return Math.min(86_400, Number(value));
}
export async function boundedJson(
  response: Response,
  maximum = 1024 * 1024,
): Promise<unknown> {
  if (
    !/^application\/(?:problem\+)?json(?:;|$)/i.test(
      response.headers.get("content-type") ?? "",
    ) ||
    Number(response.headers.get("content-length")) > maximum ||
    !response.body
  ) {
    await response.body?.cancel().catch(() => {});
    throw new DesktopApiError("API_REPLY_INVALID", response.status);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > maximum)
        throw new DesktopApiError("API_REPLY_TOO_LARGE", response.status);
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof DesktopApiError) throw error;
    throw new DesktopApiError("API_REPLY_INVALID", response.status);
  } finally {
    reader.releaseLock();
  }
}

/** Native bearer transport. No automatic POST retries and no redirected tokens. */
export class AccountApiClient {
  readonly origin: string;
  constructor(
    origin: string,
    private readonly session: () => Promise<DesktopSession>,
    private readonly isCurrent: (scope: AccountScope) => boolean,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.origin = accountApiOrigin(origin);
  }
  assertCurrent(scope: AccountScope): void {
    if (!this.isCurrent(scope)) throw new DesktopApiError("ACCOUNT_CHANGED");
  }
  async request(
    scope: AccountScope,
    path: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const target = new URL(path, this.origin);
    if (
      path.length > 8192 ||
      !/^\/[a-z0-9][a-z0-9_/-]*(?:\?[A-Za-z0-9_%=&.+~-]*)?$/.test(path) ||
      path.split("?")[0]?.includes("..") ||
      path.includes("//") ||
      target.origin !== this.origin ||
      target.hash !== "" ||
      (method === "GET" && body !== undefined)
    )
      throw new DesktopApiError("INVALID_API_PATH");
    this.assertCurrent(scope);
    const session = validateDesktopSession(await this.session(), true);
    this.assertCurrent(scope);
    if (!sameAccountScope(scope, session))
      throw new DesktopApiError("ACCOUNT_CHANGED");
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized !== undefined && Buffer.byteLength(serialized) > 64 * 1024)
      throw new DesktopApiError("API_REQUEST_TOO_LARGE");
    try {
      const response = await this.fetcher(target, {
        method,
        headers: {
          Authorization: `Bearer ${session.id_token}`,
          "X-Installation-Id": session.installation_id,
          ...(serialized !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
        ...(serialized === undefined ? {} : { body: serialized }),
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(180_000)])
          : AbortSignal.timeout(180_000),
      });
      if (!this.isCurrent(scope)) {
        await response.body?.cancel().catch(() => {});
        throw new DesktopApiError("ACCOUNT_CHANGED");
      }
      if (response.status === 204 && response.ok) return null;
      const data = await boundedJson(response);
      this.assertCurrent(scope);
      if (!response.ok) {
        const code =
          desktopRecord(data) &&
          typeof data.code === "string" &&
          /^[A-Z][A-Z0-9_]{1,63}$/.test(data.code)
            ? data.code
            : "API_REQUEST_FAILED";
        throw new DesktopApiError(
          code,
          response.status,
          retryAfter(response.headers.get("retry-after")),
        );
      }
      if (!desktopRecord(data)) throw new DesktopApiError("API_REPLY_INVALID");
      return data;
    } catch (error) {
      this.assertCurrent(scope);
      if (error instanceof DesktopApiError) throw error;
      throw new DesktopApiError(
        signal?.aborted ? "CANCELLED" : "API_UNAVAILABLE",
      );
    }
  }
}
