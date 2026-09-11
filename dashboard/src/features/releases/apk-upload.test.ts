import { describe, expect, it } from "vitest";

import { MAX_APK_BYTES, validateApk, validateUploadGrant } from "./apk-upload";

const fileWithSize = (name: string, size: number) => {
  const file = new File(["fixture"], name);
  Object.defineProperty(file, "size", { configurable: true, value: size });
  return file;
};

describe("validateApk", () => {
  it("accepts a non-empty APK at the documented 256 MiB ceiling", () => {
    expect(() =>
      validateApk(fileWithSize("release.APK", MAX_APK_BYTES)),
    ).not.toThrow();
  });

  it.each([
    ["release.zip", 1024, "Android APK"],
    ["release.apk", 0, "empty"],
    ["release.apk", MAX_APK_BYTES + 1, "256 MiB"],
  ])("rejects invalid file %s at %s bytes", (name, size, message) => {
    expect(() => validateApk(fileWithSize(name, size))).toThrow(message);
  });
});

describe("validateUploadGrant", () => {
  it("accepts an HTTPS upload destination without embedded credentials", () => {
    expect(() =>
      validateUploadGrant({ url: "https://uploads.example.test/", fields: {} }),
    ).not.toThrow();
  });

  it.each([
    "http://uploads.example.test/",
    "https://user:secret@uploads.example.test/",
    "javascript:alert(1)",
  ])("rejects unsafe upload destination %s", (url) => {
    expect(() => validateUploadGrant({ url, fields: {} })).toThrow(
      "secure HTTPS",
    );
  });
});
