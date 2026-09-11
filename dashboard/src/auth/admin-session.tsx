import type { QueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ApiClient, ApiError } from "@/api/api-client";
import type { AdminSession, Permission } from "@/api/contracts";
import { publicConfig } from "@/config";
import { createAuthAdapter } from "@/auth/firebase-adapter";

export interface AuthUser {
  uid: string;
  email: string | null;
  getIdToken(forceRefresh?: boolean): Promise<string>;
}

export interface AuthAdapter {
  observe(listener: (user: AuthUser | null) => void): () => void;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  reauthenticate(): Promise<void>;
}

export type SessionState =
  | "restoring"
  | "signedOut"
  | "checkingAccess"
  | "allowed"
  | "denied"
  | "failed";

interface AdminSessionValue {
  state: SessionState;
  session: AdminSession | null;
  client: ApiClient | null;
  error: string | null;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  reauthenticate(): Promise<void>;
  refresh(): Promise<void>;
  can(permission: Permission): boolean;
}

const AdminSessionContext = createContext<AdminSessionValue | null>(null);

interface AdminSessionProviderProps {
  children: ReactNode;
  queryClient: QueryClient;
  adapter?: AuthAdapter;
  getSession?: (signal?: AbortSignal) => Promise<AdminSession>;
}

export function AdminSessionProvider({
  children,
  queryClient,
  adapter: adapterProp,
  getSession,
}: AdminSessionProviderProps) {
  const adapter = useMemo(
    () => adapterProp ?? createAuthAdapter(),
    [adapterProp],
  );
  const [state, setState] = useState<SessionState>("restoring");
  const [session, setSession] = useState<AdminSession | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const client = useMemo(
    () =>
      user
        ? new ApiClient({
            origin: publicConfig.apiOrigin,
            getToken: (forceRefresh) => user.getIdToken(forceRefresh),
          })
        : null,
    [user],
  );

  const clearPrivilegedState = useCallback(() => {
    requestRef.current?.abort();
    setSession(null);
    queryClient.clear();
  }, [queryClient]);

  const checkAccess = useCallback(
    async (currentUser: AuthUser) => {
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      setState((current) =>
        current === "allowed" ? "allowed" : "checkingAccess",
      );
      setError(null);
      try {
        const sessionClient = new ApiClient({
          origin: publicConfig.apiOrigin,
          getToken: (forceRefresh) => currentUser.getIdToken(forceRefresh),
        });
        const next = getSession
          ? await getSession(controller.signal)
          : await sessionClient.get<AdminSession>("/admin/session", {
              signal: controller.signal,
            });
        if (controller.signal.aborted) return;
        setSession((current) => {
          if (
            current &&
            (current.uid !== next.uid ||
              current.accessRevision !== next.accessRevision ||
              current.permissions.join("|") !== next.permissions.join("|"))
          ) {
            queryClient.clear();
          }
          return next;
        });
        setState("allowed");
      } catch (caught) {
        if (controller.signal.aborted) return;
        clearPrivilegedState();
        if ((caught as ApiError | { status?: number }).status === 403) {
          setState("denied");
          setError("This Google account does not have administrator access.");
        } else {
          setState("failed");
          setError(
            caught instanceof Error
              ? caught.message
              : "Administrator access could not be checked.",
          );
        }
      }
    },
    [clearPrivilegedState, getSession, queryClient],
  );

  const refresh = useCallback(async () => {
    if (user) await checkAccess(user);
  }, [checkAccess, user]);

  useEffect(
    () =>
      adapter.observe((nextUser) => {
        setUser(nextUser);
        if (!nextUser) {
          clearPrivilegedState();
          setState("signedOut");
          setError(null);
        } else {
          void checkAccess(nextUser);
        }
      }),
    [adapter, checkAccess, clearPrivilegedState],
  );

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible" && user) void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refresh, user]);

  useEffect(() => () => requestRef.current?.abort(), []);

  const value = useMemo<AdminSessionValue>(
    () => ({
      state,
      session,
      client,
      error,
      async signIn() {
        setError(null);
        try {
          await adapter.signIn();
        } catch (caught) {
          setState("failed");
          setError(
            caught instanceof Error ? caught.message : "Sign-in was cancelled.",
          );
        }
      },
      async signOut() {
        clearPrivilegedState();
        await adapter.signOut();
      },
      async reauthenticate() {
        await adapter.reauthenticate();
        await refresh();
      },
      refresh,
      can(permission) {
        return Boolean(session?.permissions.includes(permission));
      },
    }),
    [adapter, clearPrivilegedState, client, error, refresh, session, state],
  );

  return (
    <AdminSessionContext.Provider value={value}>
      {children}
    </AdminSessionContext.Provider>
  );
}

export const useAdminSession = () => {
  const value = useContext(AdminSessionContext);
  if (!value) throw new Error("useAdminSession requires AdminSessionProvider.");
  return value;
};

export const useApiClient = () => {
  const { client } = useAdminSession();
  if (!client)
    throw new Error("The API client is unavailable while signed out.");
  return client;
};
