import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalMacUpdateMetadata,
  parseMacUpdateCandidate,
  verifyMacUpdateMetadata,
  type MacUpdateMetadata,
} from "../src/platform/macos/update-metadata.js";

const metadata: MacUpdateMetadata = {
  schemaVersion: 1,
  sequence: 7,
  platform: "darwin-arm64",
  releaseVersion: "0.2.0",
  publishedAt: "2026-09-21T00:00:00.000Z",
  expiresAt: "2026-09-23T00:00:00.000Z",
  release: {
    filename: "musicmute-worker-darwin-arm64.tar.gz",
    bytes: 1234,
    sha256: "a".repeat(64),
    contentType: "application/gzip",
  },
};

describe("signed macOS update metadata", () => {
  it("parses only a bounded HTTPS machine update response", () => {
    const candidate = {
      schemaVersion: 1,
      platform: "darwin-arm64",
      signed: { opaque: true },
      grant: {
        url: "https://storage.example.invalid/release.tar.gz?token=ok",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    };
    expect(parseMacUpdateCandidate(candidate)).toMatchObject({
      signed: { opaque: true },
      grant: { url: candidate.grant.url },
    });
    expect(
      parseMacUpdateCandidate({
        schemaVersion: 1,
        platform: "darwin-arm64",
        signed: { opaque: true },
      }),
    ).toEqual({ signed: { opaque: true } });
    expect(() =>
      parseMacUpdateCandidate({
        ...candidate,
        grant: { ...candidate.grant, url: "http://storage.invalid/release" },
      }),
    ).toThrow("unsafe or expired");
  });

  it("accepts an Ed25519 signature from the selected trusted key", () => {
    const fixture = signed(metadata);
    expect(
      verifyMacUpdateMetadata(fixture.envelope, {
        publicKeys: { "release-2026": fixture.publicKey },
        minimumSequence: 6,
        now: new Date("2026-09-22T00:00:00.000Z"),
      }),
    ).toEqual(metadata);
  });

  it("rejects tampering, unknown fields, expired metadata, and rollback", () => {
    const fixture = signed(metadata);
    const options = {
      publicKeys: { "release-2026": fixture.publicKey },
      minimumSequence: 1,
      now: new Date("2026-09-22T00:00:00.000Z"),
    };
    expect(() =>
      verifyMacUpdateMetadata(
        {
          ...fixture.envelope,
          metadata: { ...metadata, releaseVersion: "9.9.9" },
        },
        options,
      ),
    ).toThrow("signature does not match");
    expect(() =>
      verifyMacUpdateMetadata({ ...fixture.envelope, extra: true }, options),
    ).toThrow("unknown fields");
    expect(() =>
      verifyMacUpdateMetadata(fixture.envelope, {
        ...options,
        now: new Date("2026-09-24T00:00:00.000Z"),
      }),
    ).toThrow("validity window");
    expect(() =>
      verifyMacUpdateMetadata(fixture.envelope, {
        ...options,
        minimumSequence: 8,
      }),
    ).toThrow("rollback");
  });

  it("rejects a valid signature from an untrusted key", () => {
    const fixture = signed(metadata);
    expect(() =>
      verifyMacUpdateMetadata(fixture.envelope, {
        publicKeys: {},
        minimumSequence: 0,
        now: new Date("2026-09-22T00:00:00.000Z"),
      }),
    ).toThrow("not trusted");
  });
});

function signed(value: MacUpdateMetadata) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signature = sign(
    null,
    Buffer.from(canonicalMacUpdateMetadata(value), "utf8"),
    privateKey,
  ).toString("base64url");
  return {
    envelope: { keyId: "release-2026", metadata: value, signature },
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}
