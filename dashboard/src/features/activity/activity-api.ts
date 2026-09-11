import type { ApiClient } from "@/api/api-client";
import type { AuditEvent, Page } from "@/api/contracts";
import { withQuery } from "@/api/query-string";

export interface AuditFilters {
  from: string;
  to: string;
  actorUid?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  cursor?: string | null;
}

export const listAudit = (client: ApiClient, filters: AuditFilters) =>
  client.get<Page<AuditEvent>>(withQuery("/admin/audit", filters));
