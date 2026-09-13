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

export const getProcessingUsage = (client: ApiClient, id: string) =>
  client.get<import("@/api/contracts").ProcessingUsage>(
    `/admin/users/${encodeURIComponent(id)}/processing-usage`,
  );

export const setProcessingAllowance = (
  client: ApiClient,
  id: string,
  input: RevisionCommand & { allowanceAudioSeconds: number; expiresAt: string },
) =>
  submitWithReceiptReadBack({
    client,
    operationId: input.operationId,
    submit: () =>
      client.put(
        `/admin/users/${encodeURIComponent(id)}/processing-allowance`,
        input,
      ),
    readResult: () => getProcessingUsage(client, id),
  }).then(() => getProcessingUsage(client, id));

export const clearProcessingAllowance = (
  client: ApiClient,
  id: string,
  input: RevisionCommand,
) =>
  submitWithReceiptReadBack({
    client,
    operationId: input.operationId,
    submit: () =>
      client.post(
        `/admin/users/${encodeURIComponent(id)}/clear-processing-allowance`,
        input,
      ),
    readResult: () => getProcessingUsage(client, id),
  }).then(() => getProcessingUsage(client, id));
