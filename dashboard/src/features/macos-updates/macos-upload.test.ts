import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_APPCAST_BYTES,
  MAX_DMG_BYTES,
  hashDmg,
  readSignedAppcast,
  uploadDmg,
  validateDmg,
  validateMacosUploadGrant,
  validPublicEdKey,
} from "./macos-upload";
import type { MacosUploadGrant } from "./macos-updates-api";

const sha = "0".repeat(64);
const name = `MusicMute-1.2.3-4-arm64-${sha}.dmg`;
const base = "https://api.example.test/macos-updates/downloads/";
const file = (name: string, size: number) => {
  const value = new File(["fixture"], name);
  Object.defineProperty(value, "size", { value: size });
  return value;
};
const appcast = (xml: string, filename = "appcast.xml") => {
  const bytes = new TextEncoder().encode(xml);
  const value = new File([bytes], filename);
  Object.defineProperty(value, "arrayBuffer", {
    value: async () => bytes.buffer,
  });
  return value;
};
const xml = `<?xml version="1.0" encoding="utf-8"?>\n<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><item><title>MusicMute 1.2.3 · صوت</title><sparkle:version>4</sparkle:version><sparkle:shortVersionString>1.2.3</sparkle:shortVersionString><enclosure url="${base}${name}" length="7" type="application/octet-stream" sparkle:edSignature="${"A".repeat(86)}==" /></item></channel></rss>\n<!-- sparkle-signatures:\nedSignature: ${"A".repeat(86)}==\nlength: 1\n-->\n`;
const grant = (): MacosUploadGrant => ({
  method: "PUT",
  url: "https://storage.example.test/dmg?signature=fixture",
  expiresAt: "2099-01-01T00:00:00Z",
  headers: {
    "Content-Type": "application/octet-stream",
    "If-None-Match": "*",
    "x-amz-checksum-sha256": "A".repeat(43) + "=",
    "x-amz-meta-sha256": "A".repeat(43) + "=",
  },
});
afterEach(() => vi.unstubAllGlobals());

describe("Mac update file validation", () => {
  it("accepts the canonical DMG at the 2 GiB bound", () =>
    expect(() => validateDmg(file(name, MAX_DMG_BYTES))).not.toThrow());
  it.each([
    ["MusicMute.dmg", 7, "canonical"],
    [name, 0, "empty"],
    [name, MAX_DMG_BYTES + 1, "2 GiB"],
  ])("rejects %s at %s bytes", (name, size, message) =>
    expect(() => validateDmg(file(String(name), Number(size)))).toThrow(
      String(message),
    ),
  );
  it("preserves exact signed UTF-8 appcast bytes", async () => {
    const parsed = await readSignedAppcast(appcast(xml), file(name, 7), base);
    expect(
      new TextDecoder().decode(
        Uint8Array.from(atob(parsed.appcastBase64), (character) =>
          character.charCodeAt(0),
        ),
      ),
    ).toBe(xml);
    expect(parsed).toMatchObject({
      versionName: "1.2.3",
      buildNumber: "4",
      expectedSha256Hex: sha,
    });
  });
  it.each([
    xml.replace('length="7"', 'length="8"'),
    xml.replace(base, "https://other.example.test/"),
    xml.replace("<sparkle:version>4", "<sparkle:version>5"),
    xml.replace(/<!-- sparkle-signatures:[^]*$/, ""),
    "<!DOCTYPE rss [<!ENTITY external SYSTEM 'https://evil.example'>]>" + xml,
  ])(
    "rejects mismatched, unsigned or external-entity appcast",
    async (value) =>
      await expect(
        readSignedAppcast(appcast(value), file(name, 7), base),
      ).rejects.toThrow(),
  );
  it("rejects oversized appcast before reading", async () => {
    const feed = file("appcast.xml", MAX_APPCAST_BYTES + 1);
    const read = vi.fn();
    Object.defineProperty(feed, "arrayBuffer", { value: read });
    await expect(readSignedAppcast(feed, file(name, 7), base)).rejects.toThrow(
      "32 KiB",
    );
    expect(read).not.toHaveBeenCalled();
  });
  it("requires canonical 32-byte base64 public keys", () => {
    expect(validPublicEdKey("A".repeat(43) + "=")).toBe(true);
    expect(validPublicEdKey("A".repeat(42) + "B=")).toBe(false);
    expect(validPublicEdKey("private-key")).toBe(false);
  });
});

describe("immutable DMG upload", () => {
  it("uses the exact grant headers and redirect/error/privacy settings", async () => {
    const fetch = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal("fetch", fetch);
    const input = grant();
    const archive = file(name, 7);
    await uploadDmg(input, archive, new AbortController().signal, sha);
    expect(fetch).toHaveBeenCalledWith(
      input.url,
      expect.objectContaining({
        method: "PUT",
        headers: input.headers,
        body: archive,
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
      }),
    );
  });
  const invalidHeaders: Array<Record<string, string>> = [
    { Authorization: "token" },
    { "content-type": "application/octet-stream" },
    { "If-None-Match": "" },
    { "x-amz-meta-sha256": "wrong" },
    { "x-amz-checksum-sha256": "\r" },
  ];
  it.each(invalidHeaders)(
    "rejects missing, duplicate or unrelated signed headers",
    (extra) => {
      const input = grant();
      input.headers = { ...input.headers, ...extra };
      expect(() => validateMacosUploadGrant(input, sha)).toThrow("immutable");
    },
  );
  it("rejects a mismatched checksum before transfer", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      uploadDmg(
        grant(),
        file(name, 7),
        new AbortController().signal,
        "a".repeat(64),
      ),
    ).rejects.toThrow("hash");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    "http://storage.example.test/",
    "https://user:password@storage.example.test/",
    "https://storage.example.test/#fragment",
  ])("rejects unsafe upload URL %s", (url) =>
    expect(() => validateMacosUploadGrant({ ...grant(), url }, sha)).toThrow(
      "secure HTTPS",
    ),
  );
  it("rejects expired grants and cancelled transfers", async () => {
    expect(() =>
      validateMacosUploadGrant(
        { ...grant(), expiresAt: "2000-01-01T00:00:00Z" },
        sha,
      ),
    ).toThrow("expired");
    const controller = new AbortController();
    controller.abort();
    await expect(
      uploadDmg(grant(), file(name, 7), controller.signal, sha),
    ).rejects.toThrow("cancelled");
  });
  it("hashes using the existing worker in 4 MiB chunks", async () => {
    const terminate = vi.fn();
    const post = vi.fn();
    class HashWorker {
      onmessage:
        | ((event: { data: { type: string; sha256Hex: string } }) => void)
        | null = null;
      terminate = terminate;
      postMessage(input: unknown) {
        post(input);
        queueMicrotask(() =>
          this.onmessage?.({ data: { type: "complete", sha256Hex: sha } }),
        );
      }
    }
    vi.stubGlobal("Worker", HashWorker);
    const archive = file(name, MAX_DMG_BYTES);
    const fullRead = vi.fn();
    Object.defineProperty(archive, "arrayBuffer", { value: fullRead });
    expect(await hashDmg(archive, () => {}, new AbortController().signal)).toBe(
      sha,
    );
    expect(post).toHaveBeenCalledWith({
      file: archive,
      chunkBytes: 4 * 1024 * 1024,
    });
    expect(fullRead).not.toHaveBeenCalled();
    expect(terminate).toHaveBeenCalledOnce();
  });
});
