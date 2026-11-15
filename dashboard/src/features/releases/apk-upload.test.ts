import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_APK_BYTES,
  uploadApk,
  validateApk,
  validateUploadGrant,
} from "./apk-upload";

const fileWithSize = (name: string, size: number) => {
  const file = new File(["fixture"], name);
  Object.defineProperty(file, "size", { configurable: true, value: size });
  return file;
};

afterEach(() => vi.unstubAllGlobals());

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
      validateUploadGrant({
        method: "PUT",
        url: "https://uploads.example.test/",
        headers: {
          "Content-Type": "application/vnd.android.package-archive",
          "x-amz-checksum-sha256":
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          "If-None-Match": "*",
        },
      }),
    ).not.toThrow();
  });

  it.each([
    "http://uploads.example.test/",
    "https://user:secret@uploads.example.test/",
    "javascript:alert(1)",
  ])("rejects unsafe upload destination %s", (url) => {
    expect(() =>
      validateUploadGrant({
        method: "PUT",
        url,
        headers: {
          "Content-Type": "application/vnd.android.package-archive",
          "x-amz-checksum-sha256":
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          "If-None-Match": "*",
        },
      }),
    ).toThrow("secure HTTPS");
  });

  it("rejects a mutable or incomplete upload contract", () => {
    expect(() =>
      validateUploadGrant({
        method: "POST" as "PUT",
        url: "https://uploads.example.test/",
        headers: {},
      }),
    ).toThrow("invalid");
  });

  it("rejects control characters in signed header values", () => {
    expect(() =>
      validateUploadGrant({
        method: "PUT",
        url: "https://uploads.example.test/",
        headers: {
          "Content-Type": "application/vnd.android.package-archive",
          "x-amz-checksum-sha256":
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\r",
          "If-None-Match": "*",
        },
      }),
    ).toThrow("invalid");
  });
});

describe("uploadApk", () => {
  it("uses a transport that rejects redirects", async () => {
    class SuccessfulXMLHttpRequest {
      status = 204;
      upload = {};
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open() {}
      setRequestHeader() {}
      send() {
        this.onload?.();
      }
      abort() {
        this.onabort?.();
      }
    }
    const fetch = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("XMLHttpRequest", SuccessfulXMLHttpRequest);
    vi.stubGlobal("fetch", fetch);

    await uploadApk(
      {
        method: "PUT",
        url: "https://uploads.example.test/release.apk",
        headers: {
          "Content-Type": "application/vnd.android.package-archive",
          "If-None-Match": "*",
          "x-amz-checksum-sha256":
            "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        },
      },
      new File([new Uint8Array([1])], "release.apk"),
      () => undefined,
      new AbortController().signal,
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://uploads.example.test/release.apk",
      expect.objectContaining({ method: "PUT", redirect: "error" }),
    );
  });
});
