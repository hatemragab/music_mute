import type { ApiClient } from "@/api/api-client";
import type { OverviewSnapshot } from "@/api/contracts";
import { withQuery } from "@/api/query-string";

export const getOverview = (
  client: ApiClient,
  range: { from: string; to: string },
) =>
  client.get<OverviewSnapshot>(
    withQuery("/admin/overview", { ...range, bucket: "day" }),
  );
