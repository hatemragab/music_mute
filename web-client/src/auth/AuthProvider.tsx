import { initializeApp } from "firebase/app";
import {
  getAuth,
  getRedirectResult,
  onAuthStateChanged,
  signOut,
  type User,
} from "firebase/auth";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiClient, ApiError } from "../api/client";
import type { SessionView } from "../api/types";
import { readConfig } from "../config";
import { installationIdFor } from "./installation";
import { googleSignInErrorCode } from "./googleSignIn";

const config = readConfig();
export const auth = getAuth(initializeApp({ ...config.firebase }));

type AuthState =
  | { phase: "restoring"; step: "auth" | "session" }
  | { phase: "signedOut"; message?: string }
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
  const redirectResult = useRef<ReturnType<typeof getRedirectResult> | null>(
    null,
  );
  const queryClient = useQueryClient();
  useEffect(() => {
    let active = true;
    let generation = 0;
    let timedOut = false;
    let observedUser: User | null | undefined;
    let authenticatedObserved = false;
    let redirectPending = true;
    let redirectError: string | undefined;
    let sessionController: AbortController | undefined;
    const authTimeout = window.setTimeout(() => {
      if (active && !authenticatedObserved) {
        timedOut = true;
        setState({ phase: "error", message: "AUTH_RESTORE_TIMEOUT" });
      }
    }, 15_000);
    const completeSignedOut = () => {
      if (
        !active ||
        timedOut ||
        observedUser !== null ||
        (redirectPending && !authenticatedObserved)
      )
        return;
      window.clearTimeout(authTimeout);
      setState({
        phase: "signedOut",
        ...(redirectError ? { message: redirectError } : {}),
      });
    };
    const unsubscribe = onAuthStateChanged(
      auth,
      async (user) => {
        if (!active || timedOut) return;
        const current = ++generation;
        observedUser = user;
        sessionController?.abort();
        queryClient.clear();
        if (!user) {
          completeSignedOut();
          return;
        }
        authenticatedObserved = true;
        redirectError = undefined;
        window.clearTimeout(authTimeout);
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
    // Firebase consumes one redirect outcome per page load. Reuse its promise
    // across retries and StrictMode effects so cleanup cannot discard the error.
    // An authenticated session still takes precedence over a late redirect error.
    redirectResult.current ??= getRedirectResult(auth);
    void redirectResult.current.then(
      () => {
        redirectPending = false;
        completeSignedOut();
      },
      (error: unknown) => {
        redirectPending = false;
        if (!authenticatedObserved)
          redirectError = googleSignInErrorCode(error);
        completeSignedOut();
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
