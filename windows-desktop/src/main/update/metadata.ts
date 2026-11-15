import { createHash, createPublicKey, verify } from "node:crypto";
import { join } from "node:path";
import { compareWorkerReleaseVersions } from "../../../../worker/src/platform/shared/release-version.js";
import type {
  ConsumerUpdateArtifact,
  ConsumerUpdateMetadata,
  ConsumerVersionSet,
  ConsumerTargetVersionSet,
  ConsumerUpdateSource,
} from "../../shared/update-contracts.js";
import {
  readPackagedResource,
  assertPackagedPublisher,
} from "../browser/package-trust.js";
const HASH = /^[a-f0-9]{64}$/u,
  VERSION =
    /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/u;
const COMPONENTS = ["app", "runtime", "model"] as const;
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== keys.sort().join()
  )
    throw new Error("UPDATE_METADATA_INVALID");
  return value as Record<string, unknown>;
}
function version(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || !VERSION.test(value))
    throw new Error("UPDATE_METADATA_INVALID");
  return value;
}
export function consumerUpdateUrl(
  value: unknown,
  allowedOrigins: readonly string[],
): URL {
  if (typeof value !== "string" || value.length > 2048)
    throw new Error("UPDATE_METADATA_INVALID");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("UPDATE_METADATA_INVALID");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    !allowedOrigins.includes(url.origin) ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".local") ||
    /^\d+(?:\.\d+){3}$/u.test(url.hostname) ||
    url.hostname.includes(":")
  )
    throw new Error("UPDATE_METADATA_INVALID");
  return url;
}
function artifact(
  value: unknown,
  kind: (typeof COMPONENTS)[number],
  origins: readonly string[],
): ConsumerUpdateArtifact {
  const row = record(value, [
      "filename",
      "url",
      "bytes",
      "sha256",
      "contentType",
    ]),
    types = {
      app: "application/x-msdownload",
      runtime: "application/zip",
      model: "application/octet-stream",
    },
    extensions = { app: /\.exe$/u, runtime: /\.zip$/u, model: /\.onnx$/u };
  if (
    typeof row.filename !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(row.filename) ||
    !extensions[kind].test(row.filename) ||
    !Number.isSafeInteger(row.bytes) ||
    (row.bytes as number) < 1 ||
    (row.bytes as number) > (kind === "runtime" ? 4 : 2) * 1024 ** 3 ||
    typeof row.sha256 !== "string" ||
    !HASH.test(row.sha256) ||
    row.contentType !== types[kind]
  )
    throw new Error("UPDATE_METADATA_INVALID");
  return {
    filename: row.filename,
    url: consumerUpdateUrl(row.url, origins).toString(),
    bytes: row.bytes as number,
    sha256: row.sha256,
    contentType: row.contentType as string,
  };
}
export function canonicalConsumerUpdate(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalConsumerUpdate).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalConsumerUpdate(row[key])}`)
    .join(",")}}`;
}
export interface ConsumerUpdateTrust {
  feed: string;
  publicKeys: Readonly<Record<string, string>>;
  allowedOrigins: readonly string[];
  publisherSha256: string;
}
export function verifyConsumerUpdate(
  value: unknown,
  trust: ConsumerUpdateTrust,
  minimumSequence: number,
  now = new Date(),
): ConsumerUpdateMetadata {
  if (!Number.isFinite(now.getTime()))
    throw new Error("UPDATE_METADATA_INVALID");
  if (
    !Number.isSafeInteger(minimumSequence) ||
    minimumSequence < 0 ||
    Buffer.byteLength(JSON.stringify(value)) > 16384
  )
    throw new Error("UPDATE_METADATA_INVALID");
  const envelope = record(value, ["keyId", "metadata", "signature"]);
  if (
    typeof envelope.keyId !== "string" ||
    !Object.hasOwn(trust.publicKeys, envelope.keyId) ||
    typeof envelope.signature !== "string" ||
    !/^[A-Za-z0-9_-]{86}$/u.test(envelope.signature)
  )
    throw new Error("UPDATE_SIGNATURE_INVALID");
  const row = record(envelope.metadata, [
    "schemaVersion",
    "installationProfile",
    "platform",
    "channel",
    "sequence",
    "publishedAt",
    "expiresAt",
    "dataSchema",
    "publisherSha256",
    "app",
    "runtime",
    "model",
    "required",
  ]);
  if (
    row.schemaVersion !== 1 ||
    row.installationProfile !== "windows-user" ||
    row.platform !== "windows-amd64" ||
    row.channel !== "stable" ||
    row.dataSchema !== 1 ||
    row.publisherSha256 !== trust.publisherSha256 ||
    !HASH.test(trust.publisherSha256) ||
    !Number.isSafeInteger(row.sequence) ||
    (row.sequence as number) < 1 ||
    typeof row.publishedAt !== "string" ||
    typeof row.expiresAt !== "string"
  )
    throw new Error("UPDATE_METADATA_INVALID");
  const app = record(row.app, ["version", "payloadSha256", "artifact"]),
    runtime = record(row.runtime, ["version", "minimumAppVersion", "artifact"]),
    model = record(row.model, ["version", "minimumRuntimeVersion", "artifact"]),
    required = record(row.required, [
      "minimumAppVersion",
      "minimumRuntimeVersion",
      "minimumModelVersion",
    ]);
  const metadata: ConsumerUpdateMetadata = {
    schemaVersion: 1,
    installationProfile: "windows-user",
    platform: "windows-amd64",
    channel: "stable",
    sequence: row.sequence as number,
    publishedAt: row.publishedAt,
    expiresAt: row.expiresAt,
    dataSchema: 1,
    publisherSha256: trust.publisherSha256,
    app: {
      version: version(app.version),
      payloadSha256:
        typeof app.payloadSha256 === "string" && HASH.test(app.payloadSha256)
          ? app.payloadSha256
          : (() => {
              throw new Error("UPDATE_METADATA_INVALID");
            })(),
      artifact: artifact(app.artifact, "app", trust.allowedOrigins),
    },
    runtime: {
      version: version(runtime.version),
      minimumAppVersion: version(runtime.minimumAppVersion),
      artifact: artifact(runtime.artifact, "runtime", trust.allowedOrigins),
    },
    model: {
      version: version(model.version),
      minimumRuntimeVersion: version(model.minimumRuntimeVersion),
      artifact: artifact(model.artifact, "model", trust.allowedOrigins),
    },
    required: {
      minimumAppVersion: version(required.minimumAppVersion),
      minimumRuntimeVersion: version(required.minimumRuntimeVersion),
      minimumModelVersion: version(required.minimumModelVersion),
    },
  };
  let key;
  try {
    key = createPublicKey(trust.publicKeys[envelope.keyId]!);
  } catch {
    throw new Error("UPDATE_SIGNATURE_INVALID");
  }
  const signature = Buffer.from(envelope.signature, "base64url");
  if (
    key.asymmetricKeyType !== "ed25519" ||
    signature.toString("base64url") !== envelope.signature ||
    !verify(
      null,
      Buffer.from(canonicalConsumerUpdate(metadata)),
      key,
      signature,
    )
  )
    throw new Error("UPDATE_SIGNATURE_INVALID");
  const published = Date.parse(metadata.publishedAt),
    expires = Date.parse(metadata.expiresAt);
  if (
    !Number.isFinite(published) ||
    !Number.isFinite(expires) ||
    published > now.getTime() + 300000 ||
    expires <= now.getTime() ||
    expires <= published
  )
    throw new Error("UPDATE_EXPIRED");
  if (metadata.sequence < minimumSequence) throw new Error("UPDATE_REPLAY");
  if (
    compareWorkerReleaseVersions(
      metadata.app.version,
      metadata.runtime.minimumAppVersion,
    ) < 0 ||
    compareWorkerReleaseVersions(
      metadata.runtime.version,
      metadata.model.minimumRuntimeVersion,
    ) < 0
  )
    throw new Error("UPDATE_INCOMPATIBLE");
  for (const component of COMPONENTS) {
    const floor =
      metadata.required[
        `minimum${component[0]!.toUpperCase() + component.slice(1)}Version` as keyof typeof metadata.required
      ];
    if (compareWorkerReleaseVersions(metadata[component].version, floor) < 0)
      throw new Error("UPDATE_INCOMPATIBLE");
  }
  return metadata;
}
export function consumerUpdateIdentity(
  metadata: ConsumerUpdateMetadata,
): string {
  return createHash("sha256")
    .update(canonicalConsumerUpdate(metadata))
    .digest("hex");
}
export function consumerUpdateVersions(
  metadata: ConsumerUpdateMetadata,
): ConsumerTargetVersionSet {
  return Object.fromEntries(
    COMPONENTS.map((kind) => [
      kind,
      {
        version: metadata[kind].version,
        sha256:
          kind === "app"
            ? metadata.app.payloadSha256
            : metadata[kind].artifact.sha256,
      },
    ]),
  ) as ConsumerTargetVersionSet;
}
export function consumerUpdateRequired(
  metadata: ConsumerUpdateMetadata,
  current: ConsumerVersionSet,
): boolean {
  return COMPONENTS.some(
    (kind) =>
      current[kind] !== null &&
      compareWorkerReleaseVersions(
        current[kind]!.version,
        metadata.required[
          `minimum${kind[0]!.toUpperCase() + kind.slice(1)}Version` as keyof typeof metadata.required
        ],
      ) < 0,
  );
}
export async function loadConsumerUpdateTrust(
  resourcesRoot: string,
  source: ConsumerUpdateSource = "app",
): Promise<ConsumerUpdateTrust> {
  if (source !== "app" && source !== "catalog")
    throw new Error("UPDATE_REQUEST_INVALID");
  const path = join(
    resourcesRoot,
    source === "catalog"
      ? "worker-catalog-update-channel.json"
      : "update-channel.json",
  );
  const row = record(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readPackagedResource(path, 16384),
      ),
    ),
    ["version", "feed", "publicKeys", "allowedOrigins", "publisherSha256"],
  );
  if (
    row.version !== 1 ||
    !row.publicKeys ||
    typeof row.publicKeys !== "object" ||
    Array.isArray(row.publicKeys) ||
    Object.keys(row.publicKeys).length < 1 ||
    Object.keys(row.publicKeys).length > 4 ||
    typeof row.publisherSha256 !== "string" ||
    !HASH.test(row.publisherSha256) ||
    !Array.isArray(row.allowedOrigins) ||
    row.allowedOrigins.length < 1 ||
    row.allowedOrigins.length > 4 ||
    row.allowedOrigins.some((value) => typeof value !== "string")
  )
    throw new Error("UPDATE_UNAVAILABLE");
  assertPackagedPublisher(row.publisherSha256 as string);
  const allowedOrigins = row.allowedOrigins as string[];
  for (const origin of allowedOrigins)
    if (consumerUpdateUrl(origin, allowedOrigins).origin !== origin)
      throw new Error("UPDATE_UNAVAILABLE");
  const keys = row.publicKeys as Record<string, string>;
  for (const [id, pem] of Object.entries(keys)) {
    if (
      !/^[A-Za-z0-9._-]{1,64}$/u.test(id) ||
      typeof pem !== "string" ||
      pem.length > 1024
    )
      throw new Error("UPDATE_UNAVAILABLE");
    if (createPublicKey(pem).asymmetricKeyType !== "ed25519")
      throw new Error("UPDATE_UNAVAILABLE");
  }
  return {
    feed: consumerUpdateUrl(row.feed, allowedOrigins).toString(),
    allowedOrigins,
    publicKeys: keys,
    publisherSha256: row.publisherSha256,
  };
}
export function consumerUpdateSourceDescriptor(
  trust: ConsumerUpdateTrust,
): string {
  return createHash("sha256")
    .update(canonicalConsumerUpdate(trust))
    .digest("hex");
}
export async function fetchConsumerUpdate(
  trust: ConsumerUpdateTrust,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetcher(
    consumerUpdateUrl(trust.feed, trust.allowedOrigins),
    {
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      headers: { Accept: "application/json" },
    },
  );
  if (
    response.status !== 200 ||
    !response.body ||
    response.headers.get("content-type")?.split(";")[0] !== "application/json"
  )
    throw new Error("UPDATE_NETWORK_UNAVAILABLE");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 16384) {
      await response.body.cancel().catch(() => {});
      throw new Error("UPDATE_METADATA_INVALID");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    throw new Error("UPDATE_METADATA_INVALID");
  }
}
