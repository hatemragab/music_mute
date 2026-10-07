import { describe, expect, test } from "vitest";
import { PRODUCT_LINKS } from "./product-links";

describe("public MusicMute destinations", () => {
  test.each(Object.entries(PRODUCT_LINKS))(
    "%s is a clean HTTPS destination",
    (_name, value) => {
      const url = new URL(value);
      expect(url.protocol).toBe("https:");
      expect(url.username).toBe("");
      expect(url.password).toBe("");
      expect(url.search).toBe("");
    },
  );

  test("keeps the customer app separate from the public site", () => {
    expect(new URL(PRODUCT_LINKS.webApp).hostname).toBe("app.music-mute.com");
    expect(new URL(PRODUCT_LINKS.canonicalSite).hostname).toBe(
      "music-mute.com",
    );
  });
});
