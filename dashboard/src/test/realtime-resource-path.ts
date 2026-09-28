import { withQuery } from "../api/query-string";
import { fromWireCase } from "../api/wire-case";

/** Test-server adapter reusing the established synthetic HTTP fixtures. */
export function realtimeResourcePath(
  resource: string,
  wireParams: Record<string, string>,
): string {
  const params = fromWireCase(wireParams) as Record<string, string>;
  const { id, releaseId, uploadId, ...query } = params;
  const paths: Record<string, string> = {
    "admin.jobs": "/admin/jobs",
    "admin.job": `/admin/jobs/${encodeURIComponent(id ?? "")}`,
    "admin.overview": "/admin/overview",
    "admin.health": "/admin/health",
    "admin.notifications": "/admin/notifications",
    "admin.alerts": "/admin/alerts",
    "admin.workers": "/admin/worker-fleet/machines",
    "admin.worker": `/admin/worker-fleet/machines/${encodeURIComponent(id ?? "")}`,
    "admin.diagnostics": `/admin/worker-fleet/machines/${encodeURIComponent(id ?? "")}/diagnostics`,
    "admin.invitations": "/admin/worker-fleet/invitations",
    "admin.recoveries": "/admin/account-recovery-requests",
    "admin.recovery_summary": "/admin/account-recovery-requests/summary",
    "admin.release_upload": `/admin/releases/${encodeURIComponent(releaseId ?? "")}/uploads/${encodeURIComponent(uploadId ?? "")}`,
  };
  if (!paths[resource]) throw new Error(`Unexpected resource ${resource}`);
  return withQuery(paths[resource], query);
}
