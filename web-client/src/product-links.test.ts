import { expect, test } from "vitest";
import { MUSICMUTE_DOWNLOADS_URL } from "./product-links";

test("the product downloads link stays on the canonical HTTPS landing page", () => {
  const url = new URL(MUSICMUTE_DOWNLOADS_URL);

  expect(url.protocol).toBe("https:");
  expect(url.origin).toBe("https://music-mute.com");
  expect(url.pathname).toBe("/");
  expect(url.hash).toBe("#downloads");
});
