import { afterEach, expect, test, vi } from "vitest";
import { Blob as NodeBlob } from "node:buffer";
import {
  classifyAudio,
  sha256Base64,
  uploadWithProgress,
  type UploadGrant,
} from "./audio-preparation";

afterEach(() => vi.unstubAllGlobals());

test("passes a compatible low-bitrate compressed file through", () => {
  expect(classifyAudio("song.MP3", 1_000_000, 60)).toEqual({
    extension: "mp3",
    convert: false,
  });
});

test("requires conversion when average bitrate exceeds the profile cap", () => {
  expect(classifyAudio("song.mp3", 2_000_000, 60)).toEqual({
    extension: "mp3",
    convert: true,
  });
});

test("requires conversion for a decodable but unsupported container", () => {
  expect(classifyAudio("song.wav", 1_000_000, 60)).toEqual({
    extension: null,
    convert: true,
  });
});

// Fixed SHA-256 vectors exercise encoding independently of the implementation.
test("declares the canonical padded base64 checksum required by API and object storage", async () => {
  expect(await sha256Base64(new NodeBlob(["abc"]) as unknown as Blob)).toBe(
    "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=",
  );
});

const declaration = {
  contentType: "audio/mpeg",
  bytes: 3,
  sha256: "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=",
};
const grant: UploadGrant = {
  method: "PUT",
  url: "https://storage.example/music-mute/input.mp3?signature=fixture",
  expiresAt: "2026-10-01T00:00:00Z",
  headers: {
    "Content-Type": declaration.contentType,
    "x-amz-checksum-sha256": declaration.sha256,
    "x-amz-meta-sha256": declaration.sha256,
    "If-None-Match": "*",
  },
};

test("sends only signed headers and raw bytes while preserving upload progress", async () => {
  const blob = new Blob(["abc"], { type: declaration.contentType });
  const requests: TestUpload[] = [];
  class TestUpload {
    status = 204;
    withCredentials = true;
    headers: Record<string, string> = {};
    upload: {
      onprogress?: (event: {
        lengthComputable: boolean;
        loaded: number;
        total: number;
      }) => void;
    } = {};
    onload?: () => void;
    body?: Blob;
    open = vi.fn();
    constructor() {
      requests.push(this);
    }
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }
    send(body: Blob) {
      this.body = body;
      this.upload.onprogress?.({ lengthComputable: true, loaded: 3, total: 3 });
      this.onload?.();
    }
  }
  vi.stubGlobal("XMLHttpRequest", TestUpload);
  const progress = vi.fn();
  await uploadWithProgress(
    grant,
    blob,
    declaration,
    new AbortController().signal,
    progress,
  );
  expect(requests[0].open).toHaveBeenCalledWith("PUT", grant.url);
  expect(requests[0].headers).toEqual(grant.headers);
  expect(requests[0].withCredentials).toBe(false);
  expect(requests[0].body).toBe(blob);
  expect(progress).toHaveBeenCalledWith(100);
});

test("rejects unbound metadata, duplicate or credential headers and mismatched size before transport", () => {
  const transport = vi.fn();
  vi.stubGlobal("XMLHttpRequest", transport);
  const blob = new Blob(["abc"]);
  for (const headers of [
    { ...grant.headers, "x-amz-meta-sha256": "wrong" },
    { ...grant.headers, Authorization: "secret" },
    { ...grant.headers, "content-type": declaration.contentType },
    { ...grant.headers, "Content-Type": declaration.contentType + "\r" },
    Object.fromEntries(
      Object.entries(grant.headers).filter(
        ([name]) => name !== "x-amz-meta-sha256",
      ),
    ),
  ])
    expect(() =>
      uploadWithProgress(
        { ...grant, headers },
        blob,
        declaration,
        new AbortController().signal,
        () => {},
      ),
    ).toThrow("INVALID_UPLOAD_GRANT");
  for (const url of [
    "http://storage.example/file",
    "https://user:secret@storage.example/file",
    "https://storage.example/file#fragment",
  ]) {
    expect(() =>
      uploadWithProgress(
        { ...grant, url },
        blob,
        declaration,
        new AbortController().signal,
        () => {},
      ),
    ).toThrow("INVALID_UPLOAD_GRANT");
  }
  expect(() =>
    uploadWithProgress(
      grant,
      blob,
      { ...declaration, bytes: 4 },
      new AbortController().signal,
      () => {},
    ),
  ).toThrow("INVALID_UPLOAD_GRANT");
  expect(transport).not.toHaveBeenCalled();
});

test("an already cancelled upload starts no transport", async () => {
  const transport = vi.fn();
  vi.stubGlobal("XMLHttpRequest", transport);
  const controller = new AbortController();
  controller.abort();
  await expect(
    uploadWithProgress(
      grant,
      new Blob(["abc"]),
      declaration,
      controller.signal,
      () => {},
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(transport).not.toHaveBeenCalled();
});
