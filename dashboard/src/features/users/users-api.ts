import { type ApiClient, submitWithReceiptReadBack } from "@/api/api-client";
import type {
  AccountPolicyOverride,
  AccountRestriction,
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
    cursor?: string | null;
  } = {},
) => client.get<Page<UserSummary>>(withQuery("/admin/users", filters));

export const getUser = (client: ApiClient, id: string) =>
  client.get<UserDetail>(`/admin/users/${encodeURIComponent(id)}`);

export const getAccountRestriction = (client: ApiClient, id: string) =>
  client.get<AccountRestriction | null>(
    `/admin/users/${encodeURIComponent(id)}/restriction`,
  );

export const putAccountRestriction = (
  client: ApiClient,
  id: string,
  input: Pick<RevisionCommand, "expectedRevision" | "operationId"> & {
    reasonCode: AccountRestriction["reasonCode"];
    note: string;
    expiresAt?: string;
  },
) =>
  submitWithReceiptReadBack<AccountRestriction | null>({
    client,
    operationId: input.operationId,
    submit: () =>
      client.put<AccountRestriction>(
        `/admin/users/${encodeURIComponent(id)}/restriction`,
        input,
      ),
    readResult: () => getAccountRestriction(client, id),
  });

export const removeAccountRestriction = (
  client: ApiClient,
  id: string,
  input: RevisionCommand,
) =>
  submitWithReceiptReadBack<AccountRestriction | null>({
    client,
    operationId: input.operationId,
    submit: () =>
      client.delete<AccountRestriction>(
        `/admin/users/${encodeURIComponent(id)}/restriction`,
        input,
      ),
    readResult: () => getAccountRestriction(client, id),
  });

export const getAccountUsage = (client: ApiClient, id: string) =>
  client.get<import("@/api/contracts").AccountUsage>(
    `/admin/users/${encodeURIComponent(id)}/account-usage`,
  );

export const setAccountPolicyOverride = (
  client: ApiClient,
  id: string,
  input: RevisionCommand & {
    values: AccountPolicyOverride["values"];
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
