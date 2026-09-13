import type { ApiClient } from "@/api/api-client";
import type { QueueWorkload } from "@/api/contracts";
export const getQueueSummary = (client: ApiClient) =>
  client.get<QueueWorkload>("/admin/jobs/queue-summary");
