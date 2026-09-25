import { type ApiClient, submitWithReceiptReadBack } from "@/api/api-client";
import type {
  AlertRecord,
  AlertSeverity,
  HealthSnapshot,
  Page,
  RevisionCommand,
} from "@/api/contracts";
import { withQuery } from "@/api/query-string";

export const getHealth = (client: ApiClient) =>
  client.get<HealthSnapshot>("/admin/health");

export const listAlerts = (
  client: ApiClient,
  filters: {
    state?: string;
    severity?: AlertSeverity;
    cursor?: string | null;
    limit?: number;
  } = {},
) => client.get<Page<AlertRecord>>(withQuery("/admin/alerts", filters));

const readAlert = async (client: ApiClient, id: string) => {
  let cursor: string | null = null;
  let pageCount = 0;
  const visited = new Set<string>();
  do {
    if (pageCount++ >= 100) break;
    const page = await listAlerts(client, { limit: 100, cursor });
    const alert = page.items.find((item) => item.id === id);
    if (alert) return alert;
    cursor = page.nextCursor;
    if (cursor && visited.has(cursor)) break;
    if (cursor) visited.add(cursor);
  } while (cursor);
  throw new Error("The committed alert could not be found.");
};

export const acknowledgeAlert = (
  client: ApiClient,
  id: string,
  input: RevisionCommand,
) =>
  submitWithReceiptReadBack({
    client,
    operationId: input.operationId,
    submit: () =>
      client.post<AlertRecord>(
        `/admin/alerts/${encodeURIComponent(id)}/acknowledgements`,
        input,
      ),
    readResult: (receipt) => readAlert(client, receipt.resourceId ?? id),
  });
