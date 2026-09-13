import { type ApiClient, submitWithReceiptReadBack } from "@/api/api-client";
import type { ProcessingSettings, RevisionCommand } from "@/api/contracts";

export const getProcessingSettings = (client: ApiClient) =>
  client.get<ProcessingSettings>("/admin/settings/processing");

export const updateProcessingSettings = (
  client: ApiClient,
  settings: Omit<ProcessingSettings, "revision" | "updatedAt"> &
    RevisionCommand,
) =>
  submitWithReceiptReadBack({
    client,
    operationId: settings.operationId,
    submit: () =>
      client.put<ProcessingSettings>("/admin/settings/processing", settings),
    readResult: () => getProcessingSettings(client),
  });

export const getProcessingPolicyV2 = (client: ApiClient) =>
  client.get<import("@/api/contracts").ProcessingPolicyV2>(
    "/admin/settings/processing-v2",
  );

export const updateProcessingPolicyV2 = (
  client: ApiClient,
  policy: Omit<
    import("@/api/contracts").ProcessingPolicyV2,
    "revision" | "updatedAt" | "readiness" | "shortLongThresholdSeconds"
  > &
    RevisionCommand,
) =>
  submitWithReceiptReadBack({
    client,
    operationId: policy.operationId,
    submit: () =>
      client.put<import("@/api/contracts").ProcessingPolicyV2>(
        "/admin/settings/processing-v2",
        policy,
      ),
    readResult: () => getProcessingPolicyV2(client),
  }).then(() => getProcessingPolicyV2(client));
