import { expect, test } from "vitest";
import { thumbnailUrl } from "./thumbnail";

const original =
  "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg?sqp=abc_-123%3D&rs=signature_123";

test.each([
  original,
  "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg",
  "https://i.ytimg.com/vi_webp/jNQXAC9IVRw/maxresdefault.webp",
])("keeps the exact original public thumbnail URL: %s", (url) => {
  expect(thumbnailUrl(url)).toBe(url);
});

test.each([
  undefined,
  null,
  23,
  "",
  "http://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg",
  "https://i.ytimg.com.evil.test/vi/jNQXAC9IVRw/hqdefault.jpg",
  "https://user@i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg",
  "https://i.ytimg.com:443/vi/jNQXAC9IVRw/hqdefault.jpg",
  "https://i.ytimg.com/vi/short/hqdefault.jpg",
  "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.svg",
  "https://i.ytimg.com/vi/jNQXAC9IVRw/../jNQXAC9IVRw/hqdefault.jpg",
  "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg#fragment",
  "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg?token=secret",
  "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg?sqp=abc&sqp=duplicate",
  "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg?sqp=abc&rs=xyz&extra=true",
  "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg?sqp=abc&",
  "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg?sqp",
  "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg?sqp=",
  "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg?sqp=%ZZ",
  "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg?sqp=abc%0a",
  "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg?sqp=" + "a".repeat(1025),
  "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg?sqp=" + "a".repeat(2048),
  "https://i.ytimg.com\\vi/jNQXAC9IVRw/hqdefault.jpg",
  " https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg",
])("missing or unsafe artwork stays nullable: %s", (url) => {
  expect(thumbnailUrl(url)).toBeNull();
});
