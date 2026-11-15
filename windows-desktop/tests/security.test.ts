import { expect, it } from "vitest";
import {
  assetRelativePath,
  PRODUCT_LINKS,
  trustedSender,
  UI_DOCUMENT,
} from "../src/main/security.js";
it("accepts only the packaged main frame", () => {
  expect(trustedSender(UI_DOCUMENT, true)).toBe(true);
  expect(trustedSender(UI_DOCUMENT, false)).toBe(false);
  expect(trustedSender(UI_DOCUMENT + "?forged=1", true)).toBe(false);
  expect(trustedSender("https://app.music-mute.com", true)).toBe(false);
});
it("bounds packaged asset resolution", () => {
  expect(assetRelativePath("musicmute://app/app.js")).toBe("app.js");
  for (const url of [
    "musicmute://other/app.js",
    "musicmute://app/%2e%2e%2fsecret",
    "musicmute://app/%5csecret",
    "musicmute://user:pass@app/app.js",
    "musicmute://app/app.js?x=1",
    "file:///secret",
  ])
    expect(assetRelativePath(url)).toBeUndefined();
});
it("centralizes allowlisted product links without grants or tracking", () => {
  for (const value of Object.values(PRODUCT_LINKS)) {
    const url = new URL(value);
    expect(url.protocol).toBe("https:");
    expect(url.username + url.password).toBe("");
    expect(url.searchParams.has("token")).toBe(false);
  }
});
