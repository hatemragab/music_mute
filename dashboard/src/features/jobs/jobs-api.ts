import {
  OperationOutcomeUnknownError,
  type ApiClient,
  submitWithReceiptReadBack,
} from "@/api/api-client";
import type {
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
        `/admin/jobs/${encodeURIComponent(id)}/cancellations`,
        input,
      ),
    readResult: (receipt) => getJob(client, receipt.resourceId ?? id),
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
