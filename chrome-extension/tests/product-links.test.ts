import { describe, expect, it } from "vitest";
import {
  configureProductLink,
  PRODUCT_LINKS,
} from "../src/shared/product-links";

describe("extension product discovery", () => {
  it("uses the versioned companion release without credentials or tracking", () => {
    const url = new URL(PRODUCT_LINKS.companionRelease);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("github.com");
    expect(url.pathname).toBe(
      "/ahmed-dev-1/musicmute-downloads/releases/tag/macos-store-companion-2026-10-07",
    );
    expect([
      url.username,
      url.password,
      url.port,
      url.search,
      url.hash,
    ]).toEqual(["", "", "", "", ""]);
    expect(Object.isFrozen(PRODUCT_LINKS)).toBe(true);
  });

  it("opens the download destination safely outside the popup", () => {
    const link = {
      href: "musicmute-local://setup",
      target: "_self",
      rel: "",
    };
    configureProductLink(link as HTMLAnchorElement, "companionRelease");
    expect(link.href).toBe(PRODUCT_LINKS.companionRelease);
    expect(link.target).toBe("_blank");
    expect(link.rel.split(" ")).toEqual(["noopener", "noreferrer"]);
  });
  it("keeps the reviewed Downloads page distinct from any installer or platform release", () => {
    const url = new URL(PRODUCT_LINKS.downloads);
    expect(url.href).toBe("https://music-mute.com/#downloads");
    expect([url.username, url.password, url.search, url.port]).toEqual([
      "",
      "",
      "",
      "",
    ]);
    const link = { href: "", target: "", rel: "" };
    configureProductLink(link as HTMLAnchorElement, "downloads");
    expect(link).toEqual({
      href: url.href,
      target: "_blank",
      rel: "noopener noreferrer",
    });
  });
});
