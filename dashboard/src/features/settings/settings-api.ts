import { type ApiClient, submitWithReceiptReadBack } from "@/api/api-client";
import type {
  AccountPolicy,
  AccountPolicyValues,
  RevisionCommand,
} from "@/api/contracts";

export const getAccountPolicy = (client: ApiClient) =>
  client.get<AccountPolicy>("/admin/settings/account-policy");

export const updateAccountPolicy = (
  client: ApiClient,
  policy: Pick<
    AccountPolicy,
    "acceptNewJobs" | "maintenanceMessageEn" | "maintenanceMessageAr"
  > &
    AccountPolicyValues &
    RevisionCommand,
) =>
  submitWithReceiptReadBack({
    client,
    operationId: policy.operationId,
    submit: () =>
      client.put<AccountPolicy>("/admin/settings/account-policy", policy),
    readResult: () => getAccountPolicy(client),
  });
