import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AccountError } from "./errors.js";

export interface GoogleAuthorizationCode {
  authorizationCode: string;
  codeVerifier: string;
  redirectUri: string;
}
export interface GoogleOAuthPort {
  authorize(
    clientId: string,
    signal: AbortSignal,
  ): Promise<GoogleAuthorizationCode>;
}
export function parseGoogleCallback(
  target: string,
  expectedState: string,
): string {
  if (
    target.length > 8192 ||
    !target.startsWith("/oauth2callback?") ||
    target.includes("#") ||
    target.includes("\\")
  )
    throw new AccountError("OAUTH_STATE_MISMATCH");
  const url = new URL(target, "http://127.0.0.1");
  const states = url.searchParams.getAll("state");
  const state = states[0];
  if (
    url.pathname !== "/oauth2callback" ||
    states.length !== 1 ||
    !state ||
    Buffer.byteLength(state) !== Buffer.byteLength(expectedState) ||
    !timingSafeEqual(Buffer.from(state), Buffer.from(expectedState))
  )
    throw new AccountError("OAUTH_STATE_MISMATCH");
  if (url.searchParams.has("error")) throw new AccountError("CANCELLED");
  const codes = url.searchParams.getAll("code");
  const code = codes[0];
  if (
    codes.length !== 1 ||
    !code ||
    !/^[\x21-\x7e]{1,4096}$(?![\s\S])/.test(code)
  )
    throw new AccountError("OAUTH_STATE_MISMATCH");
  return code;
}

/** One listener and state per attempt; its only public effect is opening Google's fixed HTTPS origin. */
export class LoopbackGoogleOAuth implements GoogleOAuthPort {
  constructor(
    private readonly openBrowser: (url: string) => Promise<void>,
    private readonly timeoutMs = 600000,
  ) {}
  async authorize(
    clientId: string,
    signal: AbortSignal,
  ): Promise<GoogleAuthorizationCode> {
    if (
      !/^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId) ||
      clientId.length > 256
    )
      throw new AccountError("CONFIGURATION_REQUIRED");
    if (signal.aborted) throw new AccountError("CANCELLED");
    const codeVerifier = randomBytes(32).toString("base64url");
    const state = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    return new Promise((resolve, reject) => {
      let settled = false;
      let callbackConsumed = false;
      let redirectUri = "";
      let expectedHost = "";
      const finish = (error?: AccountError, code?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        server.close();
        server.closeIdleConnections();
        if (error) {
          server.closeAllConnections();
          reject(error);
        } else resolve({ authorizationCode: code!, codeVerifier, redirectUri });
      };
      const server = createServer(
        { maxHeaderSize: 4096, headersTimeout: 5000, requestTimeout: 5000 },
        (request, response) => {
          response.setHeader("Cache-Control", "no-store");
          response.setHeader("Referrer-Policy", "no-referrer");
          response.setHeader("X-Content-Type-Options", "nosniff");
          if (
            settled ||
            callbackConsumed ||
            request.method !== "GET" ||
            request.headers.host !== expectedHost ||
            !request.url ||
            request.socket.remoteAddress !== "127.0.0.1"
          ) {
            response.writeHead(400);
            response.end("Invalid callback");
            return;
          }
          let code: string;
          try {
            code = parseGoogleCallback(request.url, state);
          } catch (error) {
            response.writeHead(
              error instanceof AccountError && error.code === "CANCELLED"
                ? 200
                : 400,
            );
            response.end("Sign-in was not completed. Return to MusicMute.");
            if (error instanceof AccountError && error.code === "CANCELLED")
              response.once("finish", () => finish(error));
            return;
          }
          const script = "history.replaceState(null,'','/oauth2callback')";
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.setHeader(
            "Content-Security-Policy",
            `default-src 'none'; script-src 'sha256-${createHash("sha256").update(script).digest("base64")}'; base-uri 'none'; frame-ancestors 'none'`,
          );
          response.end(
            `<!doctype html><html lang="en"><meta charset="utf-8"><title>MusicMute sign-in</title><p>Browser step complete. Return to MusicMute to finish signing in.</p><script>${script}</script></html>`,
          );
          // Mark it consumed before another request can complete; flush this response before listener teardown.
          callbackConsumed = true;
          response.once("finish", () => {
            finish(undefined, code);
          });
        },
      );
      server.maxConnections = 16;
      server.on("clientError", (_error, socket) =>
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"),
      );
      server.once("error", () =>
        finish(new AccountError("NETWORK_UNAVAILABLE")),
      );
      const abort = () => finish(new AccountError("CANCELLED"));
      signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(
        () => finish(new AccountError("GOOGLE_SIGN_IN_TIMEOUT")),
        this.timeoutMs,
      );
      server.listen(0, "127.0.0.1", () => {
        if (settled || signal.aborted) {
          finish(new AccountError("CANCELLED"));
          return;
        }
        const port = (server.address() as AddressInfo).port;
        expectedHost = `127.0.0.1:${port}`;
        redirectUri = `http://${expectedHost}/oauth2callback`;
        const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        for (const [key, value] of Object.entries({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: "openid email profile",
          state,
          code_challenge: challenge,
          code_challenge_method: "S256",
          prompt: "select_account",
        }))
          url.searchParams.set(key, value);
        void this.openBrowser(url.toString()).catch(() =>
          finish(new AccountError("NETWORK_UNAVAILABLE")),
        );
      });
    });
  }
}
