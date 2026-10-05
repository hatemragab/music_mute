import { type ApiClient, submitWithReceiptReadBack } from "@/api/api-client";
import type { Page, RevisionCommand } from "@/api/contracts";
import { withQuery } from "@/api/query-string";

export interface MacosUpdateConfiguration {
  revision: number;
  publicEdKey: string | null;
  feedUrl: string;
  downloadBaseUrl: string;
  configured: boolean;
  selectedReleaseId: string | null;
}

export interface MacosRelease {
  id: string;
  versionName: string;
  buildNumber: string;
  archiveName: string;
  bytes: number;
  sha256Hex: string;
  state: "draft" | "published" | "withdrawn";
  artifactState: "awaiting_upload" | "verified";
  revision: number;
  createdAt: string;
  publishedAt: string | null;
  downloadUrl: string;
}

export interface MacosUploadGrant {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export interface MacosDraftInput {
  appcastBase64: string;
  archiveName: string;
  bytes: number;
  sha256Hex: string;
  operationId: string;
  reason: string;
}

export const getMacosConfiguration = (client: ApiClient) =>
  client.get<MacosUpdateConfiguration>("/admin/macos-updates/configuration");

export const configureMacosUpdates = (
  client: ApiClient,
  input: RevisionCommand & { publicEdKey: string },
) =>
  submitWithReceiptReadBack({
    client,
    operationId: input.operationId,
    submit: () =>
      client.put<MacosUpdateConfiguration>(
        "/admin/macos-updates/configuration",
        input,
      ),
    readResult: () => getMacosConfiguration(client),
  });

export const listMacosReleases = (client: ApiClient, cursor: string | null) =>
  client.get<Page<MacosRelease>>(withQuery("/admin/macos-updates", { cursor }));

export const getMacosRelease = (client: ApiClient, id: string) =>
  client.get<MacosRelease>(`/admin/macos-updates/${encodeURIComponent(id)}`);

export interface MacosDraftResult {
  release: MacosRelease;
  grant: MacosUploadGrant | null;
}

export const createMacosDraft = (client: ApiClient, input: MacosDraftInput) =>
  submitWithReceiptReadBack<MacosDraftResult>({
    client,
    operationId: input.operationId,
    submit: () => client.post<MacosDraftResult>("/admin/macos-updates", input),
    // Signed URLs are transient. A lost response recovers the committed draft;
    // only an explicit user action replays the same operation for a new grant.
    readResult: async (receipt) => ({
      release: await getMacosRelease(client, receipt.resourceId ?? ""),
      grant: null,
    }),
  });

export const completeMacosUpload = (
  client: ApiClient,
  id: string,
  operationId: string,
) =>
  submitWithReceiptReadBack({
    client,
    operationId,
    submit: () =>
      client.post<MacosRelease>(
        `/admin/macos-updates/${encodeURIComponent(id)}/completions`,
        { operationId },
      ),
    readResult: (receipt) => getMacosRelease(client, receipt.resourceId ?? id),
  });

export const reserveMacosUpload = (
  client: ApiClient,
  id: string,
  input: RevisionCommand,
) =>
  submitWithReceiptReadBack<MacosDraftResult>({
    client,
    operationId: input.operationId,
    submit: () =>
      client.post<MacosDraftResult>(
        `/admin/macos-updates/${encodeURIComponent(id)}/uploads`,
        input,
      ),
    readResult: async (receipt) => ({
      release: await getMacosRelease(client, receipt.resourceId ?? id),
      grant: null,
    }),
  });

export const changeMacosPublication = (
  client: ApiClient,
  id: string,
  action: "publications" | "withdrawals",
  input: RevisionCommand & { expectedConfigurationRevision: number },
) =>
  submitWithReceiptReadBack<{
    release: MacosRelease;
    configurationRevision: number;
    operationId: string;
  }>({
    client,
    operationId: input.operationId,
    submit: () =>
      client.post<{
        release: MacosRelease;
        configurationRevision: number;
        operationId: string;
      }>(`/admin/macos-updates/${encodeURIComponent(id)}/${action}`, input),
    readResult: async (receipt) => {
      const [release, config] = await Promise.all([
        getMacosRelease(client, receipt.resourceId ?? id),
        getMacosConfiguration(client),
      ]);
      return {
        release,
        configurationRevision: config.revision,
        operationId: input.operationId,
      };
    },
  });

export const publicMacosConfiguration = (config: MacosUpdateConfiguration) => {
  if (!config.configured || !config.publicEdKey)
    throw new Error("Configure the Sparkle public key first.");
  return (
    JSON.stringify(
      {
        schema_version: 1,
        feed_url: config.feedUrl,
        download_base_url: config.downloadBaseUrl,
        public_ed_key: config.publicEdKey,
      },
      null,
      2,
    ) + "\n"
  );
};
