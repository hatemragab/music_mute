import { type ApiClient, submitWithReceiptReadBack } from "@/api/api-client";
import type {
  Page,
  ReleaseDetail,
  ReleasePlatform,
  ReleaseProposal,
  ReleaseWriteSource,
  ReleaseSummary,
  RevisionCommand,
  UpdatePolicy,
} from "@/api/contracts";
import { withQuery } from "@/api/query-string";

export const GOOGLE_PLAY_LISTING_URL =
  "https://play.google.com/store/apps/details?id=com.hatem.musicmute";

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
  source: ReleaseWriteSource,
) =>
  client.get<ReleaseProposal>(
    withQuery("/admin/releases/proposal", { platform, source }),
  );

export interface ReleaseDraftInput {
  platform: ReleasePlatform;
  source: ReleaseWriteSource;
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
  android: { ...policy.android, source: "google_play", directReleaseId: null },
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

export const getUpdatePolicy = async (
  client: ApiClient,
): Promise<UpdatePolicy> => {
  const policy = await client.get<UpdatePolicy>("/admin/update-policy");
  return { ...policy, ...policySelection(policy) };
};

export const previewUpdatePolicy = async (
  client: ApiClient,
  policy: UpdatePolicySelection,
) => {
  const result = await client.post<{
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
  }>("/admin/update-policy/previews", policySelection(policy));
  return {
    ...result,
    examples:
      result.examples?.filter(
        (example) =>
          example.platform !== "android" || example.distribution === "play",
      ) ?? [],
  };
};

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
      }>(`/admin/releases/${encodeURIComponent(id)}/publications`, body),
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
      }>(`/admin/releases/${encodeURIComponent(id)}/withdrawals`, body),
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
