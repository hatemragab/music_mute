import { type ApiClient, submitWithReceiptReadBack } from "@/api/api-client";
import type {
  AccountRecoveryQueueSummary,
  AccountRecoveryRequest,
  Page,
  RevisionCommand,
} from "@/api/contracts";
import { withQuery } from "@/api/query-string";

export const listAccountRecoveryRequests = (
  client: ApiClient,
  filters: { status?: string; cursor?: string | null } = {},
) =>
  client.get<Page<AccountRecoveryRequest>>(
    withQuery("/admin/account-recovery-requests", filters),
  );

export const getAccountRecoverySummary = (client: ApiClient) =>
  client.get<AccountRecoveryQueueSummary>(
    "/admin/account-recovery-requests/summary",
  );

export const getAccountRecoveryRequest = (client: ApiClient, id: string) =>
  client.get<AccountRecoveryRequest>(
    `/admin/account-recovery-requests/${encodeURIComponent(id)}`,
  );

export const decideAccountRecoveryRequest = (
  client: ApiClient,
  request: AccountRecoveryRequest,
  decision: "approve" | "reject",
  input: RevisionCommand,
) =>
  submitWithReceiptReadBack<AccountRecoveryRequest>({
    client,
    operationId: input.operationId,
    submit: () =>
      client.post<AccountRecoveryRequest>(
        `/admin/account-recovery-requests/${encodeURIComponent(request.id)}/${decision === "approve" ? "approvals" : "rejections"}`,
        input,
      ),
    readResult: () => getAccountRecoveryRequest(client, request.id),
  });
