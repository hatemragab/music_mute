import { expect, it } from "vitest";
import type { UpdateMetadata } from "../../worker/src/platform/shared/update-metadata.js";
import { preparationTargetIdentity } from "../src/main/prepare/bundle.js";
import {
  parsePreparationRuntimeSource,
  runtimeDownloadUrl,
} from "../src/main/prepare/runtime-source.js";
import { modelDownloadUrl } from "../src/main/prepare/private-transfer.js";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
const metadata: UpdateMetadata = {
  schemaVersion: 1,
  platform: "windows-amd64",
  installationProfile: "windows-user",
  sequence: 1,
  releaseVersion: "0.1.0",
  publishedAt: "2026-10-08T00:00:00Z",
  expiresAt: "2026-11-08T00:00:00Z",
  release: {
    filename: "runtime.zip",
    bytes: 100,
    sha256: "f".repeat(64),
    contentType: "application/zip",
  },
};
const target = preparationTargetIdentity(metadata),
  source = {
    version: 1,
    platform: "windows-amd64",
    installationProfile: "windows-user",
    targetIdentity: target,
    filename: "runtime.zip",
    bytes: 100,
    sha256: "f".repeat(64),
    unpackedBytes: 1000,
    url: "https://downloads.music-mute.com/releases/test-only-fixture/runtime.zip",
  };
it("binds explicit sealed runtime URL to exact signed metadata/target without a default URL", () => {
  expect(parsePreparationRuntimeSource(source, metadata, target)).toEqual(
    source,
  );
  expect(() =>
    parsePreparationRuntimeSource(undefined, metadata, target),
  ).toThrow("INTEGRITY_INVALID");
});
it.each([
  { ...source, installationProfile: undefined },
  { ...source, bytes: 101 },
  { ...source, sha256: "a".repeat(64) },
  { ...source, targetIdentity: "b".repeat(64) },
  { ...source, filename: "another.zip" },
  { ...source, unpackedBytes: 17 * 1024 ** 3 },
  { ...source, unknown: true },
])(
  "refuses changed profile/bytes/digest/target/inventory bound (%j)",
  (value) => {
    expect(() =>
      parsePreparationRuntimeSource(value, metadata, target),
    ).toThrow("INTEGRITY_INVALID");
  },
);
it.each([
  "http://downloads.music-mute.com/releases/runtime.zip",
  "https://evil.example/releases/runtime.zip",
  "https://user:secret@downloads.music-mute.com/releases/runtime.zip",
  "https://downloads.music-mute.com/releases/runtime.zip?token=secret",
  "https://downloads.music-mute.com/releases/%2e%2e/runtime.zip",
  "https://downloads.music-mute.com/releases/fixture/runtime.zip#fragment",
  "https://downloads.music-mute.com:444/releases/runtime.zip",
])("refuses unsafe runtime URL %s", (url) => {
  expect(() => runtimeDownloadUrl(url)).toThrow();
});
it("keeps model acquisition upstream-only with bounded reviewed GitHub redirects", () => {
  expect(modelDownloadUrl(MODEL.url, true).toString()).toBe(MODEL.url);
  expect(() => modelDownloadUrl(source.url, true)).toThrow();
  expect(() => modelDownloadUrl("https://evil.example/model", false)).toThrow();
  expect(
    modelDownloadUrl(
      "https://release-assets.githubusercontent.com/test-only-fixture?opaque=signed",
      false,
    ).hostname,
  ).toBe("release-assets.githubusercontent.com");
});
