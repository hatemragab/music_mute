import type { ApiClient } from "./client";
import type {
  JobListView,
  JobView,
  MediaImportView,
  ProcessingPolicyView,
} from "./types";

export const jobsApi = (api: ApiClient) => ({
  list: (cursor?: string, signal?: AbortSignal) =>
    api.get<JobListView>(
      `/jobs?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      signal,
    ),
  detail: (id: string, signal?: AbortSignal) =>
    api.get<JobView>(`/jobs/${encodeURIComponent(id)}`, signal),
  createImport: (url: string, trimEnabled: boolean, requestId: string) =>
    api.post<MediaImportView>("/media-imports", {
      url,
      trimEnabled,
      requestId,
    }),
  import: (id: string, signal?: AbortSignal) =>
    api.get<MediaImportView>(
      `/media-imports/${encodeURIComponent(id)}`,
      signal,
    ),
  policy: (signal?: AbortSignal) =>
    api.get<ProcessingPolicyView>("/processing-policy", signal),
  cancel: (id: string) =>
    api.post(`/jobs/${encodeURIComponent(id)}/cancellations`, {}),
  retry: (id: string, requestId: string) =>
    api.post<{ id: string }>(`/jobs/${encodeURIComponent(id)}/retry-attempts`, {
      requestId,
    }),
  rename: (id: string, displayName: string) =>
    api.patch<JobView>(`/jobs/${encodeURIComponent(id)}`, { displayName }),
  delete: (id: string) => api.delete<void>(`/jobs/${encodeURIComponent(id)}`),
  grant: (id: string, artifact: "input" | "output", requestId: string) =>
    api.post<{ url: string; expiresAt: string }>(
      `/jobs/${encodeURIComponent(id)}/download-grants`,
      { artifact, requestId },
    ),
});
