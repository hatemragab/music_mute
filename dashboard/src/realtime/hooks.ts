import type { NotificationCampaign } from "@/features/notifications/notifications-api";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { ApiError } from "@/api/api-client";
import type {
  AccountRecoveryQueueSummary,
  AccountRecoveryRequest,
  AlertRecord,
  HealthSnapshot,
  JobDetail,
  JobSummary,
  OverviewSnapshot,
  Page,
} from "@/api/contracts";
import type { ReleaseUploadStatus } from "@/features/releases/releases-api";
import type {
  WorkerDiagnosticPage,
  WorkerMachineDetail,
  WorkerMachinePage,
} from "@/features/workers/worker-types";
import { RealtimeClient } from "./client";
interface Resources {
  "admin.notifications": Page<NotificationCampaign>;
  "admin.jobs": Page<JobSummary>;
  "admin.job": JobDetail;
  "admin.overview": OverviewSnapshot;
  "admin.health": HealthSnapshot;
  "admin.alerts": Page<AlertRecord>;
  "admin.workers": WorkerMachinePage;
  "admin.worker": WorkerMachineDetail;
  "admin.diagnostics": WorkerDiagnosticPage;
  "admin.recoveries": Page<AccountRecoveryRequest>;
  "admin.recovery_summary": AccountRecoveryQueueSummary;
  "admin.release_upload": ReleaseUploadStatus;
}
export const Context = createContext<RealtimeClient | null>(null);

export function useRealtime() {
  const client = useContext(Context);
  if (!client) throw new Error("RealtimeProvider is required");
  return client;
}
export function useLiveQuery<R extends keyof Resources>({
  queryKey,
  resource,
  params = {},
  enabled = true,
}: {
  queryKey: QueryKey;
  resource: R;
  params?: Record<string, string | number | boolean | null | undefined>;
  enabled?: boolean;
}) {
  const client = useRealtime();
  const cache = useQueryClient();
  const key = JSON.stringify(queryKey);
  const parameterKey = JSON.stringify(
    Object.fromEntries(
      Object.entries(params)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => [key, String(value)]),
    ),
  );
  const stableKey = useMemo(() => JSON.parse(key) as QueryKey, [key]);
  const stableParams = useMemo(
    () => JSON.parse(parameterKey) as Record<string, string>,
    [parameterKey],
  );
  const [failure, setFailure] = useState<{
    key: string;
    error: ApiError | null;
  }>();
  const query = useQuery<Resources[R], ApiError>({
    queryKey: stableKey,
    enabled,
    queryFn: ({ signal }) =>
      client.read<Resources[R]>(resource, stableParams, signal, true),
    staleTime: Infinity,
    retry: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (!enabled) return;
    return client.watch(resource, stableParams, (result) => {
      if (result.error) setFailure({ key, error: result.error });
      else {
        cache.setQueryData(stableKey, result.data);
        setFailure({ key, error: null });
      }
    });
  }, [client, cache, key, stableKey, resource, stableParams, enabled]);
  const error = failure?.key === key ? failure.error : query.error;
  return { ...query, error, isError: Boolean(error) };
}
