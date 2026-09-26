export interface PublicConfig {
  apiOrigin: string;
  firebase: {
    apiKey: string;
    authDomain: string;
    projectId: string;
    appId: string;
  };
}

declare global {
  interface Window {
    __MUSICMUTE_WEB_CONFIG__?: PublicConfig;
  }
}

export function validateOrigin(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("API origin must use HTTPS or local loopback HTTP.");
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("API origin must contain only scheme, host and port.");
  }
  return url.origin;
}

export function readConfig(): PublicConfig {
  const provided = window.__MUSICMUTE_WEB_CONFIG__;
  const raw = provided ?? {
    apiOrigin: import.meta.env.VITE_API_ORIGIN,
    firebase: {
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
      appId: import.meta.env.VITE_FIREBASE_APP_ID,
    },
  };
  if (
    !raw.apiOrigin ||
    !raw.firebase ||
    Object.values(raw.firebase).some(
      (value) => typeof value !== "string" || !value.trim(),
    )
  ) {
    throw new Error("MusicMute public browser configuration is incomplete.");
  }
  return { ...raw, apiOrigin: validateOrigin(raw.apiOrigin) };
}
