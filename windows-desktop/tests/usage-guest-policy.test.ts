import { expect, it, vi } from "vitest";
import {
  parseGuestPolicyOrigin,
  createGuestPolicy,
} from "../src/main/usage/guest-policy.js";
import { processingPolicy } from "./realtime-fixtures.js";
it("requires only the approved HTTPS backend origin and rejects unknown/getter/credential/path config", () => {
  expect(
    parseGuestPolicyOrigin({ backend_base_url: "https://api.example.test/" }),
  ).toBe("https://api.example.test");
  expect(
    parseGuestPolicyOrigin({
      backend_base_url: "https://api.example.test",
      firebase_api_key: null,
    }),
  ).toBe("https://api.example.test");
  for (const value of [
    { backend_base_url: "http://api.example.test" },
    { backend_base_url: "https://u:p@api.example.test" },
    { backend_base_url: "https://api.example.test/path" },
    { backend_base_url: "https://api.example.test?token=secret" },
    { backend_base_url: "https://api.example.test", secret: "forbidden" },
    {
      get backend_base_url() {
        throw new Error("must not execute getter");
      },
    },
  ])
    expect(() => parseGuestPolicyOrigin(value)).toThrow(
      "CONFIGURATION_REQUIRED",
    );
});
it("uses the existing explicit public checkout without any bearer, Firebase or realtime ticket", async () => {
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.method).toBe("GET");
      expect(new Headers(init.headers).has("Authorization")).toBe(false);
      if (url.endsWith("/processing-policy?schema_version=2"))
        return Response.json(processingPolicy());
      if (url.endsWith("/app-policy"))
        return Response.json({
          platforms: { windows: { minimum_build: null } },
          require_verified_email: false,
        });
      throw new Error("unexpected endpoint");
    }),
    guest = createGuestPolicy({
      origin: "https://api.example.test",
      installationId: "00000000-0000-4000-8000-000000000000",
      fetch,
    });
  expect(fetch).not.toHaveBeenCalled();
  await guest.onAppOpen();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(guest.usage.view()).toMatchObject({
    authenticated: false,
    connection: "stopped",
    usage: null,
    policyState: "current",
    policy: { linkImportVisible: true },
  });
  expect(() =>
    guest.usage.assertCloudSubmission({
      state: "signed-out",
      online: false,
      access: { allowed: false, reason: "SIGN_IN_REQUIRED" },
    }),
  ).toThrow("SIGN_IN_REQUIRED");
  await Promise.resolve();
  expect(fetch).toHaveBeenCalledTimes(2);
  guest.dispose();
});
