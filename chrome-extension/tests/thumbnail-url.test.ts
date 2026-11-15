import { describe, expect, it } from "vitest";
import { publicThumbnailUrl } from "../src/shared/thumbnail-url.js";

const thumbnail = "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg";

describe("original public thumbnail URL", () => {
  it.each([
    thumbnail,
    "https://i.ytimg.com/vi_webp/jNQXAC9IVRw/hqdefault.webp",
    thumbnail + "?sqp=fixture_123%3D%3D&rs=signature-123",
  ])("preserves %s exactly", (value) => {
    expect(publicThumbnailUrl(value)).toBe(value);
  });
  it.each([
    undefined,
    null,
    1,
    {},
    "",
    thumbnail + "#",
    thumbnail + "\n",
    thumbnail.replace("https:", "http:"),
    thumbnail.replace("i.ytimg.com", "i.ytimg.com.evil.invalid"),
    thumbnail.replace("i.ytimg.com", "user:secret@i.ytimg.com"),
    thumbnail.replace("i.ytimg.com", "i.ytimg.com:443"),
    thumbnail.replace("/vi/", "/vi/../vi/"),
    thumbnail.replace("/vi/", "\\vi/"),
    thumbnail + "?token=secret",
    thumbnail + "?sqp=one&sqp=two",
    thumbnail + "?sqp=one&",
    thumbnail + "?sqp=one%0A",
    thumbnail + "?rs=" + "x".repeat(1025),
  ])("omits invalid optional thumbnail %j", (value) => {
    expect(publicThumbnailUrl(value)).toBeNull();
  });
});
