import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type { User } from "firebase/auth";
import type { ApiClient } from "../src/api/client";
import { Shell } from "../src/App";
import { AuthContext } from "../src/auth/AuthProvider";
import { I18nProvider } from "../src/i18n";
import "../src/styles.css";

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
const state = { phase: "signedIn" as const, user, session, api };

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    <I18nProvider>
      <MemoryRouter>
        <AuthContext.Provider
          value={{ state, retry: () => {}, logout: async () => {} }}
        >
          <Shell />
        </AuthContext.Provider>
      </MemoryRouter>
    </I18nProvider>
  </QueryClientProvider>,
);
