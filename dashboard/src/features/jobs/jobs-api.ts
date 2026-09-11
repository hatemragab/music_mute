import {
  OperationOutcomeUnknownError,
  type ApiClient,
  submitWithReceiptReadBack,
} from "@/api/api-client";
import type {
  AttemptSummary,
  JobDetail,
  JobSummary,
  MediaGrant,
  Page,
  RevisionCommand,
} from "@/api/contracts";
import { withQuery, type QueryValue } from "@/api/query-string";

export interface JobFilters {
  status?: string;
  userId?: string;
  workerId?: string;
  jobId?: string;
  from?: string;
  to?: string;
  cursor?: string | null;
}

export const listJobs = (client: ApiClient, filters: JobFilters = {}) =>
  client.get<Page<JobSummary>>(
    withQuery("/admin/jobs", filters as Record<string, QueryValue>),
  );

export const getJob = (client: ApiClient, id: string) =>
  client.get<JobDetail>(`/admin/jobs/${encodeURIComponent(id)}`);

export const getJobAttempts = (
  client: ApiClient,
  id: string,
  cursor?: string | null,
) =>
  client.get<Page<AttemptSummary>>(
    withQuery(`/admin/jobs/${encodeURIComponent(id)}/attempts`, { cursor }),
  );

export const cancelJob = (
  client: ApiClient,
  id: string,
  input: RevisionCommand,
) =>
  submitWithReceiptReadBack<JobDetail>({
    client,
    operationId: input.operationId,
    submit: () =>
      client.post<JobDetail>(
        `/admin/jobs/${encodeURIComponent(id)}/cancel`,
        input,
      ),
    readResult: (receipt) => getJob(client, receipt.resourceId ?? id),
  });

export const retryJob = (
  client: ApiClient,
  id: string,
  input: RevisionCommand,
) =>
  submitWithReceiptReadBack<{
    sourceJobId: string;
    newJobId: string;
    status: "queued";
  }>({
    client,
    operationId: input.operationId,
    submit: () =>
      client.post<{
        sourceJobId: string;
        newJobId: string;
        status: "queued";
      }>(`/admin/jobs/${encodeURIComponent(id)}/retry`, input),
    readResult: async (receipt) => {
      if (!receipt.resourceId)
        throw new Error("The retry receipt has no new job identifier.");
      await getJob(client, receipt.resourceId);
      return {
        sourceJobId: id,
        newJobId: receipt.resourceId,
        status: "queued",
      };
    },
  });

export const requestMediaGrant = (
  client: ApiClient,
  id: string,
  input: {
    asset: "input" | "result";
    purpose: "play" | "download";
    operationId: string;
    reason: string;
  },
) =>
  submitWithReceiptReadBack<MediaGrant>({
    client,
    operationId: input.operationId,
    submit: () =>
      client.post<MediaGrant>(
        `/admin/jobs/${encodeURIComponent(id)}/media-grants`,
        input,
      ),
    readResult: () => {
      throw new OperationOutcomeUnknownError(
        input.operationId,
        "The media grant was created, but its short-lived URL response was lost. Close this dialog and request a new reviewed grant.",
      );
    },
  });
