import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged, signOut, type User } from "firebase/auth";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiClient, ApiError } from "../api/client";
import type { SessionView } from "../api/types";
import { readConfig } from "../config";
import { installationIdFor } from "./installation";

const config = readConfig();
export const auth = getAuth(initializeApp({ ...config.firebase }));

type AuthState =
  | { phase: "restoring"; step: "auth" | "session" }
  | { phase: "signedOut" }
  | { phase: "error"; message: string }
  | { phase: "recovery"; user: User; api: ApiClient }
  | { phase: "signedIn"; user: User; session: SessionView; api: ApiClient };

interface AuthContextValue {
  state: AuthState;
  retry: () => void;
  logout: () => Promise<void>;
}
export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    phase: "restoring",
    step: "auth",
  });
  const [revision, setRevision] = useState(0);
  const queryClient = useQueryClient();
  useEffect(() => {
    let active = true;
    let generation = 0;
    let timedOut = false;
    let sessionController: AbortController | undefined;
    const authTimeout = window.setTimeout(() => {
      if (active && generation === 0) {
        timedOut = true;
        setState({ phase: "error", message: "AUTH_RESTORE_TIMEOUT" });
      }
    }, 15_000);
    const unsubscribe = onAuthStateChanged(
      auth,
      async (user) => {
        if (!active || timedOut) return;
        const current = ++generation;
        window.clearTimeout(authTimeout);
        sessionController?.abort();
        queryClient.clear();
        if (!user) {
          setState({ phase: "signedOut" });
          return;
        }
        setState({ phase: "restoring", step: "session" });
        const controller = new AbortController();
        sessionController = controller;
        let sessionTimeout: number | undefined;
        let api: ApiClient | undefined;
        try {
          const installationId = installationIdFor(user.uid);
          api = new ApiClient({
            origin: config.apiOrigin,
            token: (refresh) => user.getIdToken(refresh),
            installationId: () => installationId,
          });
          const client = api;
          const metadata = {
            platform: "web",
            appVersion: import.meta.env.VITE_APP_VERSION || "0.1.0",
            buildNumber: 1,
            metadataRevision: 1,
            osVersion: navigator.platform?.slice(0, 64) || "browser",
            deviceModel: "Web browser",
          };
          const session = await Promise.race([
            client.post<SessionView>(
              "/auth/sessions",
              { ...metadata, installationId },
              controller.signal,
            ),
            new Promise<never>((_, reject) => {
              sessionTimeout = window.setTimeout(() => {
                controller.abort();
                reject(new Error("SESSION_TIMEOUT"));
              }, 15_000);
            }),
          ]);
          if (active && current === generation)
            setState({ phase: "signedIn", user, session, api: client });
        } catch (error) {
          if (active && current === generation)
            setState(
              error instanceof ApiError &&
                error.code === "ACCOUNT_DELETION_PENDING" &&
                api
                ? { phase: "recovery", user, api }
                : {
                    phase: "error",
                    message:
                      error instanceof Error ? error.message : "REQUEST_FAILED",
                  },
            );
        } finally {
          window.clearTimeout(sessionTimeout);
          if (sessionController === controller) sessionController = undefined;
        }
      },
      (error) => {
        window.clearTimeout(authTimeout);
        if (active && !timedOut) {
          timedOut = true;
          generation++;
          sessionController?.abort();
          setState({ phase: "error", message: error.message });
        }
      },
    );
    return () => {
      active = false;
      generation++;
      window.clearTimeout(authTimeout);
      sessionController?.abort();
      unsubscribe();
    };
  }, [queryClient, revision]);
  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      retry: () => {
        setState({ phase: "restoring", step: "auth" });
        setRevision((value) => value + 1);
      },
      logout: async () => {
        queryClient.clear();
        await signOut(auth);
      },
    }),
    [state, queryClient],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("AuthProvider is required.");
  return context;
}

export function useSignedIn() {
  const { state } = useAuth();
  if (state.phase !== "signedIn")
    throw new Error("A signed-in session is required.");
  return state;
}
