import { createPublicKey, verify } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/u;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export interface MacUpdateArtifact {
  filename: string;
  bytes: number;
  sha256: string;
  contentType: "application/gzip";
}

export interface MacUpdateMetadata {
  schemaVersion: 1;
  sequence: number;
  platform: "darwin-arm64";
  releaseVersion: string;
  publishedAt: string;
  expiresAt: string;
  release: MacUpdateArtifact;
}

export interface SignedMacUpdateMetadata {
  keyId: string;
  metadata: MacUpdateMetadata;
  signature: string;
}

export interface MacUpdateCandidate {
  signed: unknown;
  grant?: { url: string; expiresAt: string };
}

export function parseMacUpdateCandidate(value: unknown): MacUpdateCandidate {
  const root = strictRecord(
    value,
    new Set(["schemaVersion", "platform", "signed", "grant"]),
    "Update candidate",
    false,
  );
  if (root.schemaVersion !== 1 || root.platform !== "darwin-arm64")
    throw new TypeError("Update candidate target is invalid");
  if (root.grant === undefined) return { signed: root.signed };
  const grant = strictRecord(
    root.grant,
    new Set(["url", "expiresAt"]),
    "Update grant",
    false,
  );
  if (typeof grant.url !== "string" || typeof grant.expiresAt !== "string")
    throw new TypeError("Update grant is invalid");
  const url = new URL(grant.url);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    !Number.isFinite(Date.parse(grant.expiresAt)) ||
    Date.parse(grant.expiresAt) <= Date.now()
  )
    throw new TypeError("Update grant is unsafe or expired");
  return {
    signed: root.signed,
    grant: { url: url.toString(), expiresAt: grant.expiresAt },
  };
}

export function verifyMacUpdateMetadata(
  value: unknown,
  options: {
    publicKeys: Readonly<Record<string, string>>;
    minimumSequence: number;
    now?: Date;
  },
): MacUpdateMetadata {
  if (
    !Number.isSafeInteger(options.minimumSequence) ||
    options.minimumSequence < 0
  )
    throw new TypeError("Minimum update sequence is invalid");
  const envelope = strictRecord(
    value,
    new Set(["keyId", "metadata", "signature"]),
    "Update envelope",
  );
  if (typeof envelope.keyId !== "string" || !KEY_ID.test(envelope.keyId))
    throw new TypeError("Update signing key ID is invalid");
  if (
    typeof envelope.signature !== "string" ||
    !/^[A-Za-z0-9_-]{86}$/u.test(envelope.signature)
  )
    throw new TypeError("Update signature is invalid");
  const metadata = parseMetadata(envelope.metadata);
  const publicKey = options.publicKeys[envelope.keyId];
  if (publicKey === undefined)
    throw new TypeError("Update signing key is not trusted");
  let key;
  try {
    key = createPublicKey(publicKey);
  } catch {
    throw new TypeError("Update public key is invalid");
  }
  if (key.asymmetricKeyType !== "ed25519")
    throw new TypeError("Update public key must use Ed25519");
  const signature = Buffer.from(envelope.signature, "base64url");
  if (
    !verify(null, Buffer.from(canonicalJson(metadata), "utf8"), key, signature)
  )
    throw new TypeError("Update metadata signature does not match");
  const now = (options.now ?? new Date()).getTime();
  const publishedAt = Date.parse(metadata.publishedAt);
  const expiresAt = Date.parse(metadata.expiresAt);
  if (
    !Number.isFinite(publishedAt) ||
    !Number.isFinite(expiresAt) ||
    publishedAt > now + MAX_CLOCK_SKEW_MS ||
    expiresAt <= now ||
    expiresAt <= publishedAt
  )
    throw new TypeError("Update metadata validity window is invalid");
  if (metadata.sequence < options.minimumSequence)
    throw new TypeError("Update metadata sequence is a rollback");
  return metadata;
}

export function canonicalMacUpdateMetadata(
  metadata: MacUpdateMetadata,
): string {
  return canonicalJson(metadata);
}

function parseMetadata(value: unknown): MacUpdateMetadata {
  const record = strictRecord(
    value,
    new Set([
      "schemaVersion",
      "sequence",
      "platform",
      "releaseVersion",
      "publishedAt",
      "expiresAt",
      "release",
    ]),
    "Update metadata",
  );
  if (
    record.schemaVersion !== 1 ||
    record.platform !== "darwin-arm64" ||
    !Number.isSafeInteger(record.sequence) ||
    (record.sequence as number) < 1 ||
    typeof record.releaseVersion !== "string" ||
    !VERSION.test(record.releaseVersion) ||
    typeof record.publishedAt !== "string" ||
    typeof record.expiresAt !== "string"
  )
    throw new TypeError("Update metadata is invalid");
  const release = strictRecord(
    record.release,
    new Set(["filename", "bytes", "sha256", "contentType"]),
    "Update release",
  );
  if (
    typeof release.filename !== "string" ||
    !FILENAME.test(release.filename) ||
    !Number.isSafeInteger(release.bytes) ||
    (release.bytes as number) < 1 ||
    typeof release.sha256 !== "string" ||
    !SHA256.test(release.sha256) ||
    release.contentType !== "application/gzip"
  )
    throw new TypeError("Update release metadata is invalid");
  return {
    schemaVersion: 1,
    sequence: record.sequence as number,
    platform: "darwin-arm64",
    releaseVersion: record.releaseVersion,
    publishedAt: record.publishedAt,
    expiresAt: record.expiresAt,
    release: {
      filename: release.filename,
      bytes: release.bytes as number,
      sha256: release.sha256,
      contentType: "application/gzip",
    },
  };
}

function strictRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
  rejectUnknown = true,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} is invalid`);
  const record = value as Record<string, unknown>;
  if (rejectUnknown && Object.keys(record).some((key) => !allowed.has(key)))
    throw new TypeError(`${label} contains unknown fields`);
  return record;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
