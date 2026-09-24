export interface PublicConfig {
  apiOrigin: string;
  basePath: string;
  firebase: {
    apiKey: string;
    authDomain: string;
    projectId: string;
    appId: string;
  } | null;
  sentry: { enabled: boolean; dsn: string };
}

export type RuntimePublicConfig = PublicConfig;

declare global {
  interface Window {
    __MUSICMUTE_RUNTIME_CONFIG__?: RuntimePublicConfig;
  }
}

const normalizeBasePath = (value: string | undefined) => {
  const path = value?.trim() || "/";
  if (!path.startsWith("/") || path.includes("://")) {
    throw new Error("VITE_APP_BASE_PATH must be a root-relative path.");
  }
  return path.endsWith("/") ? path : `${path}/`;
};

const runtimeConfig =
  typeof window === "undefined"
    ? undefined
    : window.__MUSICMUTE_RUNTIME_CONFIG__;

const buildFirebaseConfig = (): PublicConfig["firebase"] => {
  if (runtimeConfig) return runtimeConfig.firebase;
  return import.meta.env.VITE_FIREBASE_API_KEY &&
    import.meta.env.VITE_FIREBASE_AUTH_DOMAIN &&
    import.meta.env.VITE_FIREBASE_PROJECT_ID &&
    import.meta.env.VITE_FIREBASE_APP_ID
    ? {
        apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
        authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
        projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
        appId: import.meta.env.VITE_FIREBASE_APP_ID,
      }
    : null;
};

export const publicConfig: PublicConfig = {
  apiOrigin: (
    runtimeConfig?.apiOrigin ||
    import.meta.env.VITE_API_ORIGIN ||
    "http://127.0.0.1:3000"
  ).replace(/\/$/, ""),
  basePath: normalizeBasePath(
    runtimeConfig?.basePath ?? import.meta.env.VITE_APP_BASE_PATH,
  ),
  firebase: buildFirebaseConfig(),
  sentry: runtimeConfig?.sentry ?? {
    enabled: import.meta.env.VITE_SENTRY_ENABLED === "true",
    dsn: import.meta.env.VITE_SENTRY_DSN || "",
  },
};
