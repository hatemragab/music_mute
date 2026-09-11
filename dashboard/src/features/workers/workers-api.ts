import {
  OperationOutcomeUnknownError,
  type ApiClient,
  submitWithReceiptReadBack,
} from "@/api/api-client";
import type {
  Page,
  RevisionCommand,
  WorkerDetail,
  WorkerSummary,
} from "@/api/contracts";
import { withQuery } from "@/api/query-string";

export const listWorkers = (
  client: ApiClient,
  filters: { state?: string; online?: boolean; cursor?: string | null } = {},
) => client.get<Page<WorkerSummary>>(withQuery("/admin/workers", filters));

export const getWorker = (client: ApiClient, id: string) =>
  client.get<WorkerDetail>(`/admin/workers/${encodeURIComponent(id)}`);

export const createWorker = (
  client: ApiClient,
  input: { id: string; label: string; operationId: string; reason: string },
) =>
  submitWithReceiptReadBack<{ worker: WorkerSummary; rawKey: string }>({
    client,
    operationId: input.operationId,
    submit: () =>
      client.post<{ worker: WorkerSummary; rawKey: string }>(
        "/admin/workers",
        input,
      ),
    readResult: (receipt) => {
      throw new OperationOutcomeUnknownError(
        input.operationId,
        `Worker ${receipt.resourceId ?? input.id} was registered, but its one-time key response was lost. Open the worker and rotate its key before installation.`,
      );
    },
  });

export const renameWorker = (
  client: ApiClient,
  id: string,
  input: RevisionCommand & { label: string },
) =>
  submitWithReceiptReadBack<WorkerSummary>({
    client,
    operationId: input.operationId,
    submit: () =>
      client.patch<WorkerSummary>(
        `/admin/workers/${encodeURIComponent(id)}`,
        input,
      ),
    readResult: (receipt) => getWorker(client, receipt.resourceId ?? id),
  });

export const workerAction = (
  client: ApiClient,
  id: string,
  action: "drain" | "enable" | "rotate-key" | "revoke",
  input: RevisionCommand & { emergency?: boolean },
) => {
  const body =
    action === "revoke"
      ? { ...input, emergency: input.emergency ?? false }
      : {
          expectedRevision: input.expectedRevision,
          operationId: input.operationId,
          reason: input.reason,
        };
  return submitWithReceiptReadBack<
    WorkerSummary | { worker: WorkerSummary; rawKey: string }
  >({
    client,
    operationId: input.operationId,
    submit: () =>
      client.post<WorkerSummary | { worker: WorkerSummary; rawKey: string }>(
        `/admin/workers/${encodeURIComponent(id)}/${action}`,
        body,
      ),
    readResult: (receipt) => {
      if (action === "rotate-key")
        throw new OperationOutcomeUnknownError(
          input.operationId,
          `Worker ${receipt.resourceId ?? id} has a new key, but the one-time key response was lost. Rotate the key again before installation.`,
        );
      return getWorker(client, receipt.resourceId ?? id);
    },
  });
};

export const releaseStoppedWorker = (
  client: ApiClient,
  id: string,
  input: RevisionCommand & {
    jobId: string;
    attemptId: string;
    sessionId: string;
    generation: number;
    stoppedAt: string;
    stopEvidence: string;
  },
) =>
  submitWithReceiptReadBack<WorkerSummary>({
    client,
    operationId: input.operationId,
    submit: () =>
      client.post<WorkerSummary>(
        `/admin/workers/${encodeURIComponent(id)}/release-stopped`,
        input,
      ),
    readResult: (receipt) => getWorker(client, receipt.resourceId ?? id),
  });
