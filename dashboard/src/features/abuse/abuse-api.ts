import type { ApiClient } from "@/api/api-client";
import type { AbuseEvent, AbuseEventType, Page } from "@/api/contracts";
import { withQuery } from "@/api/query-string";

export interface AbuseEventFilters {
  accountId?: string;
  type?: AbuseEventType;
  severity?: "low" | "medium" | "high";
  from?: string;
  to?: string;
  cursor?: string | null;
}

export const listAbuseEvents = (
  client: ApiClient,
  filters: AbuseEventFilters,
) => client.get<Page<AbuseEvent>>(withQuery("/admin/abuse-events", filters));
