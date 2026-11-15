import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  LoopbackGoogleOAuth,
  parseGoogleCallback,
} from "../src/main/account/google-oauth.js";

describe("Google loopback system-browser flow", () => {
  it("binds loopback, opens only Google with S256, rejects wrong state, and consumes one valid callback", async () => {
    let opened: URL | null = null;
    let browserResponse = "";
    const flow = new LoopbackGoogleOAuth(async (value) => {
      opened = new URL(value);
      expect(opened.origin).toBe("https://accounts.google.com");
      expect(opened.searchParams.has("client_secret")).toBe(false);
      const redirect = opened.searchParams.get("redirect_uri")!;
      expect(redirect).toMatch(
        /^http:\/\/127\.0\.0\.1:[0-9]+\/oauth2callback$/,
      );
      const wrong = await fetch(`${redirect}?state=wrong&code=wrong-code`);
      expect(wrong.status).toBe(400);
      const good = await fetch(
        `${redirect}?state=${opened.searchParams.get("state")}&code=synthetic-code`,
      );
      expect(good.status).toBe(200);
      browserResponse = await good.text();
      expect(good.headers.get("cache-control")).toBe("no-store");
      expect(good.headers.get("content-security-policy")).toContain(
        "default-src 'none'",
      );
    }, 1000);
    const result = await flow.authorize(
      "123-fixture.apps.googleusercontent.com",
      new AbortController().signal,
    );
    await vi.waitFor(() =>
      expect(browserResponse).toContain("history.replaceState"),
    );
    const url = opened as unknown as URL;
    expect(result.authorizationCode).toBe("synthetic-code");
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(result.codeVerifier).digest("base64url"),
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(browserResponse).not.toContain("synthetic-code");
    expect(browserResponse).not.toContain(url.searchParams.get("state"));
    expect(browserResponse).toContain("history.replaceState");
  });
  it.each([
    "/oauth2callback?state=wrong&code=ok",
    "/oauth2callback?state=correct&state=correct&code=ok",
    "/oauth2callback?state=correct&code=one&code=two",
    "/oauth2callback?state=correct&code=ok%0A",
    "/oauth2callback?state=correct&code=ok#fragment",
    "//attacker.example/oauth2callback?state=correct&code=ok",
    "/other?state=correct&code=ok",
  ])("rejects malformed/duplicate callback %s", (target) => {
    expect(() => parseGoogleCallback(target, "correct")).toThrow(
      "OAUTH_STATE_MISMATCH",
    );
  });
  it("handles user cancellation, timeout, failed browser launch and pre-cancelled attempts", async () => {
    const cancelled = new LoopbackGoogleOAuth(async (value) => {
      const url = new URL(value);
      await fetch(
        `${url.searchParams.get("redirect_uri")}?state=${url.searchParams.get("state")}&error=access_denied`,
      );
    }, 1000);
    await expect(
      cancelled.authorize(
        "123-fixture.apps.googleusercontent.com",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    const timeout = new LoopbackGoogleOAuth(async () => undefined, 20);
    await expect(
      timeout.authorize(
        "123-fixture.apps.googleusercontent.com",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "GOOGLE_SIGN_IN_TIMEOUT" });
    const failed = new LoopbackGoogleOAuth(async () => {
      throw new Error("sensitive-native-browser-fixture");
    }, 1000);
    await expect(
      failed.authorize(
        "123-fixture.apps.googleusercontent.com",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE" });
    const abort = new AbortController();
    abort.abort();
    await expect(
      timeout.authorize("123-fixture.apps.googleusercontent.com", abort.signal),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
