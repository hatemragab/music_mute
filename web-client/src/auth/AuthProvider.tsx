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
  | { phase: "restoring" }
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
  const [state, setState] = useState<AuthState>({ phase: "restoring" });
  const [revision, setRevision] = useState(0);
  const queryClient = useQueryClient();
  useEffect(() => {
    let active = true;
    let generation = 0;
    const unsubscribe = onAuthStateChanged(
      auth,
      async (user) => {
        const current = ++generation;
        queryClient.clear();
        if (!active) return;
        if (!user) {
          setState({ phase: "signedOut" });
          return;
        }
        setState({ phase: "restoring" });
        const installationId = installationIdFor(user.uid);
        const api = new ApiClient({
          origin: config.apiOrigin,
          token: (refresh) => user.getIdToken(refresh),
          installationId: () => installationId,
        });
        try {
          const metadata = {
            platform: "web",
            appVersion: import.meta.env.VITE_APP_VERSION || "0.1.0",
            buildNumber: 1,
            metadataRevision: 1,
            osVersion: navigator.platform?.slice(0, 64) || "browser",
            deviceModel: "Web browser",
          };
          const session = await api.post<SessionView>("/auth/sessions", {
            ...metadata,
            installationId,
          });
          if (active && current === generation)
            setState({ phase: "signedIn", user, session, api });
        } catch (error) {
          if (active && current === generation)
            setState(
              error instanceof ApiError &&
                error.code === "ACCOUNT_DELETION_PENDING"
                ? { phase: "recovery", user, api }
                : {
                    phase: "error",
                    message:
                      error instanceof Error ? error.message : "REQUEST_FAILED",
                  },
            );
        }
      },
      (error) => setState({ phase: "error", message: error.message }),
    );
    return () => {
      active = false;
      generation++;
      unsubscribe();
    };
  }, [queryClient, revision]);
  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      retry: () => setRevision((value) => value + 1),
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
