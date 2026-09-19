import { type ApiClient, submitWithReceiptReadBack } from "@/api/api-client";
import type {
  Page,
  RevisionCommand,
  UserDetail,
  UserSummary,
} from "@/api/contracts";
import { withQuery } from "@/api/query-string";

export const listUsers = (
  client: ApiClient,
  filters: {
    query?: string;
    status?: string;
    processingSuspended?: boolean;
    cursor?: string | null;
  } = {},
) => client.get<Page<UserSummary>>(withQuery("/admin/users", filters));

export const getUser = (client: ApiClient, id: string) =>
  client.get<UserDetail>(`/admin/users/${encodeURIComponent(id)}`);

export const setProcessingSuspended = (
  client: ApiClient,
  id: string,
  suspended: boolean,
  input: RevisionCommand & { expiresAt?: string },
) =>
  submitWithReceiptReadBack<UserSummary>({
    client,
    operationId: input.operationId,
    submit: () =>
      client.post<UserSummary>(
        `/admin/users/${encodeURIComponent(id)}/${suspended ? "suspend-processing" : "resume-processing"}`,
        input,
      ),
    readResult: (receipt) => getUser(client, receipt.resourceId ?? id),
  });

export const getAccountUsage = (client: ApiClient, id: string) =>
  client.get<import("@/api/contracts").AccountUsage>(
    `/admin/users/${encodeURIComponent(id)}/account-usage`,
  );

export const setAccountPolicyOverride = (
  client: ApiClient,
  id: string,
  input: RevisionCommand & {
    values: { monthlyProcessingSeconds: number };
    expiresAt: string | null;
  },
) =>
  submitWithReceiptReadBack({
    client,
    operationId: input.operationId,
    submit: () =>
      client.put(
        `/admin/users/${encodeURIComponent(id)}/account-policy-override`,
        input,
      ),
    readResult: () => getAccountUsage(client, id),
  }).then(() => getAccountUsage(client, id));

export const clearAccountPolicyOverride = (
  client: ApiClient,
  id: string,
  input: RevisionCommand,
) =>
  submitWithReceiptReadBack({
    client,
    operationId: input.operationId,
    submit: () =>
      client.delete(
        `/admin/users/${encodeURIComponent(id)}/account-policy-override`,
        input,
      ),
    readResult: () => getAccountUsage(client, id),
  }).then(() => getAccountUsage(client, id));
