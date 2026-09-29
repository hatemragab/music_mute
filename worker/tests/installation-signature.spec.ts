import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyInstallationSignature } from "../src/enrollment/installation-signature.js";
import type { InstallationReleaseGrant } from "../src/enrollment/enrollment-client.js";
import {
  canonicalUpdateMetadata,
  type UpdateMetadata,
  type UpdatePlatform,
} from "../src/platform/shared/update-metadata.js";

const keys = generateKeyPairSync("ed25519");
const publicKeys = {
  fixture: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
};

function release(platform: UpdatePlatform): InstallationReleaseGrant {
  const metadata: UpdateMetadata = {
    schemaVersion: 1,
    sequence: 3,
    platform,
    releaseVersion: "0.1.0-rc.2",
    publishedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    release: {
      filename: platform === "darwin-arm64" ? "runtime.tar.gz" : "runtime.zip",
      bytes: 123,
      sha256: "a".repeat(64),
      contentType:
        platform === "darwin-arm64" ? "application/gzip" : "application/zip",
    },
  };
  return {
    ...metadata.release,
    version: metadata.releaseVersion,
    url: "https://storage.example.invalid/runtime",
    expiresAt: metadata.expiresAt,
    signed: {
      keyId: "fixture",
      metadata,
      signature: sign(
        null,
        Buffer.from(canonicalUpdateMetadata(metadata)),
        keys.privateKey,
      ).toString("base64url"),
    },
  };
}

describe("initial runtime signatures", () => {
  it.each(["darwin-arm64", "windows-amd64"] as const)(
    "authenticates the exact %s release",
    (platform) => {
      expect(() =>
        verifyInstallationSignature(release(platform), platform, publicKeys),
      ).not.toThrow();
    },
  );
  it("rejects unsigned and untrusted releases", () => {
    const candidate = release("darwin-arm64");
    expect(() =>
      verifyInstallationSignature(
        { ...candidate, signed: undefined },
        "darwin-arm64",
        publicKeys,
      ),
    ).toThrow();
    expect(() =>
      verifyInstallationSignature(candidate, "darwin-arm64"),
    ).toThrow("not trusted");
  });
  it("rejects tampered signatures and a different platform", () => {
    const candidate = release("darwin-arm64");
    const signed = candidate.signed as {
      keyId: string;
      metadata: UpdateMetadata;
      signature: string;
    };
    expect(() =>
      verifyInstallationSignature(
        { ...candidate, signed: { ...signed, signature: "a".repeat(86) } },
        "darwin-arm64",
        publicKeys,
      ),
    ).toThrow("signature does not match");
    expect(() =>
      verifyInstallationSignature(candidate, "windows-amd64", publicKeys),
    ).toThrow();
  });
  it.each(["filename", "bytes", "sha256", "contentType", "version"] as const)(
    "rejects substituted %s even with a valid signature",
    (field) => {
      const candidate = release("darwin-arm64");
      const tampered = {
        ...candidate,
        [field]: field === "bytes" ? 124 : "substituted",
      };
      expect(() =>
        verifyInstallationSignature(tampered, "darwin-arm64", publicKeys),
      ).toThrow("does not match signed metadata");
    },
  );
});
