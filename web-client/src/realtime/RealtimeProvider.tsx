import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryKey,
} from "@tanstack/react-query";
import { ApiError } from "../api/client";
import type { JobListView } from "../api/types";
import { useAuth, useSignedIn } from "../auth/AuthProvider";
import { readConfig } from "../config";
import { useI18n } from "../i18n";
import { RealtimeClient } from "./client";

const Context = createContext<RealtimeClient | null>(null);

export function RealtimeProvider({
  children,
  client: supplied,
}: {
  children: ReactNode;
  client?: RealtimeClient;
}) {
  const { api } = useSignedIn();
  const { retry } = useAuth();
  const cache = useQueryClient();
  const client = useMemo(
    () =>
      supplied ??
      new RealtimeClient({
        origin: readConfig().apiOrigin,
        ticket: (signal, refresh) =>
          api.request("POST", "/realtime-tickets", {}, signal, refresh),
        onSessionExpired: () => {
          cache.clear();
          retry();
        },
      }),
    [api, supplied, cache, retry],
  );
  const state = useSyncExternalStore(client.onState, client.getState);
  useEffect(() => {
    if (state === "signedOut") cache.clear();
  }, [cache, state]);
  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);
  return (
    <Context.Provider value={client}>
      {state === "signedOut" ? <ConnectionIndicator /> : children}
    </Context.Provider>
  );
}

export function useRealtime() {
  const client = useContext(Context);
  if (!client) throw new Error("RealtimeProvider is required");
  return client;
}

export function ConnectionIndicator() {
  const client = useRealtime();
  const state = useSyncExternalStore(client.onState, client.getState);
  const { t } = useI18n();
  const { retry } = useAuth();
  return (
    <div
      className={`connection-state connection-${state}`}
      role="status"
      aria-live="polite"
    >
      <span className="connection-dot" aria-hidden="true" />
      <span>
        {t(
          state === "live"
            ? "updatesLive"
            : state === "offline"
              ? "updatesOffline"
              : state === "signedOut"
                ? "updatesSignIn"
                : state === "connecting"
                  ? "updatesConnecting"
                  : "updatesReconnecting",
        )}
      </span>
      {state === "signedOut" ? (
        <button type="button" onClick={retry}>
          {t("retry")}
        </button>
      ) : null}
    </div>
  );
}

export function useLiveQuery<T>(
  queryKey: QueryKey,
  resource: string,
  params: Record<string, string> = {},
  enabled = true,
) {
  const client = useRealtime();
  const cache = useQueryClient();
  const key = JSON.stringify(queryKey);
  const parameterKey = JSON.stringify(params);
  const stableKey = useMemo(() => JSON.parse(key) as QueryKey, [key]);
  const stableParams = useMemo(
    () => JSON.parse(parameterKey) as Record<string, string>,
    [parameterKey],
  );
  const [failure, setFailure] = useState<{
    key: string;
    error: ApiError | null;
  }>();
  const query = useQuery<T, ApiError>({
    queryKey: stableKey,
    enabled,
    queryFn: ({ signal }) => client.read<T>(resource, stableParams, signal),
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
  }, [client, cache, resource, stableParams, stableKey, key, enabled]);
  const error = failure?.key === key ? failure.error : query.error;
  return { ...query, error, isError: Boolean(error) };
}

export function useLiveJobs() {
  const { user } = useSignedIn();
  const client = useRealtime();
  const cache = useQueryClient();
  const queryKey = useMemo(() => [user.uid, "jobs"], [user.uid]);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      client.read<JobListView>(
        "jobs",
        { limit: "20", ...(pageParam ? { cursor: pageParam } : {}) },
        signal,
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    maxPages: 10,
    staleTime: Infinity,
    retry: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });
  const cursors = JSON.stringify(query.data?.pageParams ?? [null]);
  useEffect(() => {
    const pages = JSON.parse(cursors) as Array<string | null>;
    const cleanups = pages.map((cursor, index) =>
      client.watch(
        "jobs",
        { limit: "20", ...(cursor ? { cursor } : {}) },
        (result) => {
          if (result.error) {
            setFailure(result.error);
            return;
          }
          setFailure(null);
          const page = result.data as JobListView;
          cache.setQueryData<InfiniteData<JobListView, string | undefined>>(
            queryKey,
            (current) => {
              if (!current)
                return index === 0
                  ? { pages: [page], pageParams: [undefined] }
                  : current;
              if (
                index >= current.pages.length ||
                current.pageParams[index] !== (cursor ?? undefined)
              )
                return current;
              const changedBoundary =
                current.pages[index]?.nextCursor !== page.nextCursor;
              const next = current.pages.map((value, at) =>
                at === index ? page : value,
              );
              return {
                pages: changedBoundary ? next.slice(0, index + 1) : next,
                pageParams: changedBoundary
                  ? current.pageParams.slice(0, index + 1)
                  : current.pageParams,
              };
            },
          );
        },
      ),
    );
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [client, cache, queryKey, cursors]);
  const error = failure ?? query.error;
  return { ...query, error, isError: Boolean(error) };
}
