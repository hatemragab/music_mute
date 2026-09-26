import {
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAdminSession, useApiClient } from "@/auth/admin-session";
import { publicConfig } from "@/config";
import { RealtimeClient } from "./client";
import { Context, useRealtime } from "./hooks";

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const api = useApiClient();
  const { session, refresh } = useAdminSession();
  const cache = useQueryClient();
  const revision = session?.accessRevision;
  const client = useMemo(
    () =>
      new RealtimeClient({
        origin: publicConfig.apiOrigin,
        ticket: (signal, refresh) =>
          api.request(
            "POST",
            "/admin/realtime-tickets",
            { body: {}, signal },
            refresh,
          ),
        onSessionExpired: () => {
          cache.clear();
          void refresh();
        },
      }),
    [api, cache, refresh],
  );
  const state = useSyncExternalStore(client.onState, client.getState);
  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client, revision]);
  useEffect(() => {
    if (state === "signedOut") cache.clear();
  }, [cache, state]);
  return (
    <Context.Provider value={client}>
      {state === "signedOut" ? (
        <div role="alert" className="p-6">
          Access must be checked again.{" "}
          <button onClick={() => void refresh().then(() => client.reconnect())}>
            Check access
          </button>
        </div>
      ) : (
        children
      )}
    </Context.Provider>
  );
}
export function ConnectionIndicator() {
  const client = useRealtime();
  const state = useSyncExternalStore(client.onState, client.getState);
  return (
    <span
      role="status"
      className="flex items-center gap-2 text-xs text-muted-foreground"
    >
      <span
        aria-hidden="true"
        className={`size-2 rounded-full ${state === "live" ? "bg-emerald-500" : "bg-amber-500"}`}
      />
      {state === "live"
        ? "Live updates"
        : state === "offline"
          ? "Offline · showing last update"
          : "Connecting to live updates…"}
    </span>
  );
}
