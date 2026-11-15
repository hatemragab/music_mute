export type ConsumerUpdateComponent = "app" | "runtime" | "model";
export type ConsumerUpdateSource = "app" | "catalog";
export interface ConsumerComponentIdentity {
  version: string;
  sha256: string;
}
export type ConsumerTargetVersionSet = Record<
  ConsumerUpdateComponent,
  ConsumerComponentIdentity
>;
/** Verified installed bytes; current GPU qualification is a separate operation scope. */
export interface ConsumerVersionSet {
  app: ConsumerComponentIdentity;
  runtime: ConsumerComponentIdentity | null;
  model: ConsumerComponentIdentity | null;
}
export interface ConsumerUpdateArtifact {
  filename: string;
  url: string;
  bytes: number;
  sha256: string;
  contentType: string;
}
export interface ConsumerUpdateMetadata {
  schemaVersion: 1;
  installationProfile: "windows-user";
  platform: "windows-amd64";
  channel: "stable";
  sequence: number;
  publishedAt: string;
  expiresAt: string;
  dataSchema: 1;
  publisherSha256: string;
  app: {
    version: string;
    payloadSha256: string;
    artifact: ConsumerUpdateArtifact;
  };
  runtime: {
    version: string;
    minimumAppVersion: string;
    artifact: ConsumerUpdateArtifact;
  };
  model: {
    version: string;
    minimumRuntimeVersion: string;
    artifact: ConsumerUpdateArtifact;
  };
  required: {
    minimumAppVersion: string;
    minimumRuntimeVersion: string;
    minimumModelVersion: string;
  };
}
export interface ConsumerSignedUpdate {
  keyId: string;
  metadata: ConsumerUpdateMetadata;
  signature: string;
}
export type ConsumerUpdatePhase =
  | "idle"
  | "available"
  | "current"
  | "downloading"
  | "waiting"
  | "activating"
  | "health-check"
  | "restart-required"
  | "complete"
  | "rolled-back"
  | "blocked";
export type ConsumerUpdateScope = "app-only" | "prepared";
export interface ConsumerUpdateView {
  distribution?: "microsoft-store";
  phase: ConsumerUpdatePhase;
  available: ConsumerTargetVersionSet | null;
  scope?: ConsumerUpdateScope;
  required: boolean;
  automaticDiscovery: boolean;
  problem: string | null;
}
export type ConsumerUpdateCommand = { version: 1; request_id: string } & (
  | { action: "check" }
  | { action: "install" }
  | { action: "recover" }
  | { action: "automatic_discovery"; enabled: boolean }
  | { action: "store_open"; product: "gui" | "worker" }
);
export function parseConsumerUpdateCommand(
  value: unknown,
): ConsumerUpdateCommand {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("UPDATE_REQUEST_INVALID");
  const row = value as Record<string, unknown>;
  if (
    row.version !== 1 ||
    typeof row.request_id !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
      row.request_id,
    )
  )
    throw new Error("UPDATE_REQUEST_INVALID");
  const extra =
    row.action === "automatic_discovery"
      ? ["enabled"]
      : row.action === "store_open"
        ? ["product"]
        : [];
  if (
    ![
      "check",
      "install",
      "recover",
      "automatic_discovery",
      "store_open",
    ].includes(String(row.action)) ||
    Object.keys(row).sort().join() !==
      ["version", "request_id", "action", ...extra].sort().join() ||
    (row.action === "automatic_discovery" &&
      typeof row.enabled !== "boolean") ||
    (row.action === "store_open" &&
      row.product !== "gui" &&
      row.product !== "worker")
  )
    throw new Error("UPDATE_REQUEST_INVALID");
  return row as unknown as ConsumerUpdateCommand;
}
