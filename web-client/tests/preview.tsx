import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type { User } from "firebase/auth";
import type { ApiClient } from "../src/api/client";
import { Shell } from "../src/App";
import { AuthContext } from "../src/auth/AuthProvider";
import { StartupScreen } from "../src/auth/StartupScreen";
import { I18nProvider } from "../src/i18n";
import "../src/styles.css";
import { RealtimeClient } from "../src/realtime/client";
import { realtimeFixture } from "./realtime-fixture";

const networkRealtime = new URLSearchParams(location.search).has(
  "network-realtime",
);
const createdAt = "2026-09-24T11:00:00.000Z";
const jobs = [
  {
    id: "0123456789abcdef01234567",
    requestId: crypto.randomUUID(),
    sourceTitle: "City lights",
    displayName: "City lights — vocals",
    sourceKind: "file",
    status: "ready",
    createdAt,
    updatedAt: createdAt,
    processingProgress: null,
    error: null,
    canDownloadInput: true,
    canDownloadOutput: true,
    input: { extension: "mp3", bytes: 2450000, durationSeconds: 190 },
  },
  {
    id: "6abaade2a3f12dc9ed43c129",
    requestId: crypto.randomUUID(),
    sourceTitle: null,
    displayName: null,
    sourceKind: "file",
    status: "ready",
    createdAt,
    updatedAt: createdAt,
    processingProgress: null,
    error: null,
    canDownloadInput: false,
    canDownloadOutput: true,
    input: { extension: "mp3", bytes: 800000, durationSeconds: 148 },
  },
  {
    id: "3123456789abcdef01234567",
    requestId: crypto.randomUUID(),
    sourceTitle: "Second take",
    displayName: "Second take",
    sourceKind: "file",
    status: "ready",
    createdAt,
    updatedAt: createdAt,
    processingProgress: null,
    error: null,
    canDownloadInput: true,
    canDownloadOutput: true,
    input: { extension: "mp3", bytes: 1200000, durationSeconds: 96 },
  },
  {
    id: "1123456789abcdef01234567",
    requestId: crypto.randomUUID(),
    sourceTitle: "Evening melody",
    displayName: "Evening melody",
    sourceKind: "url",
    status: "processing",
    createdAt,
    updatedAt: createdAt,
    processingProgress: { phase: "separating", phasePercent: 42, stale: false },
    error: null,
    canDownloadInput: false,
    canDownloadOutput: false,
    input: { extension: "m4a", bytes: 3100000, durationSeconds: 230 },
  },
  {
    id: "2123456789abcdef01234567",
    requestId: crypto.randomUUID(),
    sourceTitle: "Old recording",
    displayName: "Old recording",
    sourceKind: "file",
    status: "failed",
    createdAt,
    updatedAt: createdAt,
    processingProgress: null,
    error: { code: "INVALID_AUDIO", message: "Invalid audio" },
    canDownloadInput: false,
    canDownloadOutput: false,
    input: { extension: "mp3", bytes: 200000, durationSeconds: 16 },
  },
];
const api = {
  get: async (path: string) => {
    if (
      networkRealtime &&
      /^\/(jobs|processing-policy|processing-usage)/.test(path)
    )
      throw new Error("Unexpected HTTP status read");
    if (path.startsWith("/jobs?")) return { items: jobs, nextCursor: null };
    if (path.startsWith("/jobs/"))
      return jobs.find((job) => path.includes(job.id));
    if (path === "/processing-policy")
      return {
        acceptNewJobs: true,
        messageEn: null,
        messageAr: null,
        limits: {
          maxDurationSeconds: 1200,
          maxPreparedAudioBytes: 50_000_000,
          maxLocalSourceBytes: 200_000_000,
        },
        preparationProfile: {
          id: "audio-cap-aac-lc-160-v1",
          compatibilityRevision: "1",
        },
      };
    if (path === "/processing-usage")
      return {
        processing: {
          usedSeconds: 432,
          limitSeconds: 3600,
          remainingSeconds: 3168,
        },
        availability: { status: "available", reason: null },
        period: { nextResetAt: "2026-10-01T00:00:00.000Z" },
        storage: { retainedBytes: 1_000_000, limitBytes: 100_000_000 },
      };
    if (path.startsWith("/users/me/devices"))
      return {
        items: [
          {
            installationId: "a68f0a23-57dc-4e15-bb3e-e13dc4ed7d01",
            platform: "web",
            deviceModel: "Web browser",
            firstSeenAt: createdAt,
            lastSeenAt: createdAt,
          },
        ],
        nextCursor: null,
      };
    throw new Error(`Unmocked read: ${path}`);
  },
  post: async () => {
    throw new Error("Preview is read-only");
  },
} as unknown as ApiClient;

const { client: fixtureClient } = realtimeFixture((resource, params) => {
  const path =
    resource === "jobs"
      ? "/jobs?limit=20"
      : resource === "job"
        ? `/jobs/${params.id}`
        : resource === "policy"
          ? "/processing-policy"
          : resource === "usage"
            ? "/processing-usage"
            : "";
  return api.get(path);
});

const realtimeClient = networkRealtime
  ? new RealtimeClient({
      origin: "http://127.0.0.1:3000",
      ticket: async () =>
        (
          await fetch("http://127.0.0.1:3000/realtime-tickets", {
            method: "POST",
          })
        ).json(),
    })
  : fixtureClient;

const user = {
  uid: "preview-only",
  email: "preview@example.invalid",
  providerData: [{ providerId: "password" }],
} as User;
const session = {
  user: {
    id: "preview",
    displayName: "Sample listener",
    email: "preview@example.invalid",
    emailVerified: true,
    providers: ["password"],
  },
  access: { allowed: true },
};
const previewParams = new URLSearchParams(window.location.search);
const startup = previewParams.get("startup");
if (previewParams.get("lang") === "ar")
  localStorage.setItem("musicmute.web.language", "ar");
const state =
  startup === "auth" || startup === "session"
    ? { phase: "restoring" as const, step: startup }
    : startup === "error"
      ? { phase: "error" as const, message: "SESSION_TIMEOUT" }
      : { phase: "signedIn" as const, user, session, api };

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    <I18nProvider>
      <MemoryRouter>
        <AuthContext.Provider
          value={{ state, retry: () => {}, logout: async () => {} }}
        >
          {startup ? (
            <StartupScreen />
          ) : (
            <Shell realtimeClient={realtimeClient} />
          )}
        </AuthContext.Provider>
      </MemoryRouter>
    </I18nProvider>
  </QueryClientProvider>,
);
