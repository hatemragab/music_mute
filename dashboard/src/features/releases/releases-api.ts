import {
  OperationOutcomeUnknownError,
  type ApiClient,
  submitWithReceiptReadBack,
} from "@/api/api-client";
import type {
  Page,
  ReleaseDetail,
  ReleasePlatform,
  ReleaseProposal,
  ReleaseSource,
  ReleaseSummary,
  RevisionCommand,
  UpdatePolicy,
} from "@/api/contracts";
import { withQuery } from "@/api/query-string";

export const listReleases = (
  client: ApiClient,
  filters: {
    platform?: string;
    source?: string;
    state?: string;
    cursor?: string | null;
  } = {},
) => client.get<Page<ReleaseSummary>>(withQuery("/admin/releases", filters));

export const getRelease = (client: ApiClient, id: string) =>
  client.get<ReleaseDetail>(`/admin/releases/${encodeURIComponent(id)}`);

export const getReleaseProposal = (
  client: ApiClient,
  platform: ReleasePlatform,
  source: ReleaseSource,
) =>
  client.get<ReleaseProposal>(
    withQuery("/admin/releases/proposal", { platform, source }),
  );

export interface ReleaseDraftInput {
  platform: ReleasePlatform;
  source: ReleaseSource;
  versionName: string;
  buildNumber: number;
  changelogEn: string;
  storeUrl: string | null;
}

export type ReleaseEditInput = Omit<ReleaseDraftInput, "platform" | "source"> &
  RevisionCommand;

export type UpdatePolicySelection = Pick<UpdatePolicy, "android" | "ios">;

const policySelection = (
  policy: UpdatePolicySelection,
): UpdatePolicySelection => ({
  android: policy.android,
  ios: policy.ios,
});

export const createRelease = (
  client: ApiClient,
  input: ReleaseDraftInput & { operationId: string; reason: string },
) =>
  submitWithReceiptReadBack({
    client,
    operationId: input.operationId,
    submit: () => client.post<ReleaseDetail>("/admin/releases", input),
    readResult: (receipt) => getRelease(client, receipt.resourceId ?? ""),
  });

export const updateRelease = (
  client: ApiClient,
  id: string,
  input: ReleaseEditInput &
    Partial<Pick<ReleaseDraftInput, "platform" | "source">>,
) => {
  const {
    versionName,
    buildNumber,
    changelogEn,
    storeUrl,
    expectedRevision,
    operationId,
    reason,
  } = input;
  const body = {
    versionName,
    buildNumber,
    changelogEn,
    storeUrl,
    expectedRevision,
    operationId,
    reason,
  };
  return submitWithReceiptReadBack({
    client,
    operationId,
    submit: () =>
      client.patch<ReleaseDetail>(
        `/admin/releases/${encodeURIComponent(id)}`,
        body,
      ),
    readResult: (receipt) => getRelease(client, receipt.resourceId ?? id),
  });
};

export const reserveReleaseUpload = (
  client: ApiClient,
  id: string,
  input: {
    bytes: number;
    sha256Hex: string;
    expectedRevision: number;
    operationId: string;
  },
) =>
  submitWithReceiptReadBack<{
    uploadId: string;
    grant: {
      method: "PUT";
      url: string;
      headers: Record<string, string>;
      expiresAt: string;
    };
    expectedBytes: number;
    expectedSha256: string;
  }>({
    client,
    operationId: input.operationId,
    submit: () =>
      client.post<{
        uploadId: string;
        grant: {
          method: "PUT";
          url: string;
          headers: Record<string, string>;
          expiresAt: string;
        };
        expectedBytes: number;
        expectedSha256: string;
      }>(`/admin/releases/${encodeURIComponent(id)}/uploads`, input),
    readResult: (receipt) => {
      throw new OperationOutcomeUnknownError(
        input.operationId,
        `Upload ${receipt.resourceId ?? "reservation"} was reserved, but its one-time upload grant response was lost. Refresh the release and reserve a new upload.`,
      );
    },
  });

export interface ReleaseUploadStatus {
  artifactState: string;
  code?: string;
  checkedAt?: string;
}

export const completeReleaseUpload = (
  client: ApiClient,
  releaseId: string,
  uploadId: string,
) => {
  const operationId = crypto.randomUUID();
  return submitWithReceiptReadBack<ReleaseUploadStatus>({
    client,
    operationId,
    submit: () =>
      client.post<ReleaseUploadStatus>(
        `/admin/releases/${encodeURIComponent(releaseId)}/uploads/${encodeURIComponent(uploadId)}/complete`,
        { operationId },
      ),
    readResult: (receipt) =>
      getReleaseUpload(client, releaseId, receipt.resourceId ?? uploadId),
  });
};

export const getReleaseUpload = (
  client: ApiClient,
  releaseId: string,
  uploadId: string,
) =>
  client.get<ReleaseUploadStatus>(
    `/admin/releases/${encodeURIComponent(releaseId)}/uploads/${encodeURIComponent(uploadId)}`,
  );

export const getUpdatePolicy = (client: ApiClient) =>
  client.get<UpdatePolicy>("/admin/update-policy");

export const previewUpdatePolicy = (
  client: ApiClient,
  policy: UpdatePolicySelection,
) =>
  client.post<{
    currentRevision: number;
    valid: boolean;
    errors: string[];
    examples: Array<{
      platform: string;
      distribution: string;
      installedBuild: number;
      decision: string;
      targetBuild: number | null;
    }>;
  }>("/admin/update-policy/preview", policySelection(policy));

export const publishRelease = (
  client: ApiClient,
  id: string,
  input: {
    expectedRevision: number;
    expectedReleaseRevision: number;
    policy: UpdatePolicySelection;
    operationId: string;
    reason: string;
    storeAvailabilityConfirmed: boolean;
  },
) => {
  const body = { ...input, policy: policySelection(input.policy) };
  return submitWithReceiptReadBack<{
    release: ReleaseDetail;
    policyRevision: number;
    operationId: string;
  }>({
    client,
    operationId: input.operationId,
    submit: () =>
      client.post<{
        release: ReleaseDetail;
        policyRevision: number;
        operationId: string;
      }>(`/admin/releases/${encodeURIComponent(id)}/publish`, body),
    readResult: async (receipt) => {
      const [release, policy] = await Promise.all([
        getRelease(client, receipt.resourceId ?? id),
        getUpdatePolicy(client),
      ]);
      return {
        release,
        policyRevision: policy.revision,
        operationId: input.operationId,
      };
    },
  });
};

export const withdrawRelease = (
  client: ApiClient,
  id: string,
  input: {
    expectedRevision: number;
    expectedReleaseRevision: number;
    replacementPolicy: UpdatePolicySelection;
    operationId: string;
    reason: string;
  },
) => {
  const body = {
    ...input,
    replacementPolicy: policySelection(input.replacementPolicy),
  };
  return submitWithReceiptReadBack<{
    release: ReleaseDetail;
    policyRevision: number;
    operationId: string;
  }>({
    client,
    operationId: input.operationId,
    submit: () =>
      client.post<{
        release: ReleaseDetail;
        policyRevision: number;
        operationId: string;
      }>(`/admin/releases/${encodeURIComponent(id)}/withdraw`, body),
    readResult: async (receipt) => {
      const [release, policy] = await Promise.all([
        getRelease(client, receipt.resourceId ?? id),
        getUpdatePolicy(client),
      ]);
      return {
        release,
        policyRevision: policy.revision,
        operationId: input.operationId,
      };
    },
  });
};
