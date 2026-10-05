import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import { friendlyError, I18nProvider } from "../i18n";
import { HomePage } from "./HomePage";
import * as audioPreparation from "./audio-preparation";
import { RealtimeProvider } from "../realtime/RealtimeProvider";
import { realtimeFixture } from "../../tests/realtime-fixture";
import type { MediaImportView } from "../api/types";

const mockAuth = vi.hoisted(() => ({
  api: null as unknown,
  user: { uid: "test-user" },
  session: { access: { allowed: true } },
}));
vi.mock("../auth/AuthProvider", () => ({
  useSignedIn: () => mockAuth,
  useAuth: () => ({ retry: vi.fn() }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
  mockAuth.user = { uid: "test-user" };
  mockAuth.session = { access: { allowed: true } };
});

interface PageOptions {
  readImport?: (id: string) => MediaImportView;
  acceptNewJobs?: boolean;
}

function page(
  policyFailure = false,
  importStatus = "queued",
  importErrorCode = "IMPORT_SOURCE_UNAVAILABLE",
  options: PageOptions = {},
) {
  const fixture = realtimeFixture((resource, params) => {
    if (resource === "policy") {
      if (policyFailure) throw new ApiError(503, "SERVICE_UNAVAILABLE");
      return {
        acceptNewJobs: options.acceptNewJobs ?? true,
        limits: {
          maxDurationSeconds: 1200,
          maxPreparedAudioBytes: 50_000_000,
          maxLocalSourceBytes: 200_000_000,
        },
      };
    }
    if (resource === "jobs") return { items: [], nextCursor: null };
    if (resource === "import")
      return (
        options.readImport?.(params.id) ?? {
          importId: params.id,
          status: importStatus,
          jobId:
            importStatus === "submitted" ? "0123456789abcdef01234569" : null,
          error: importStatus === "failed" ? { code: importErrorCode } : null,
        }
      );
    throw new Error(`Unexpected subscription: ${resource}`);
  });
  mockAuth.api = new ApiClient({
    origin: "https://api.example.com",
    token: async () => "test-token",
    installationId: () => "f68f0a23-57dc-4e15-bb3e-e13dc4ed7d01",
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <MemoryRouter>
          <RealtimeProvider client={fixture.client}>
            <HomePage />
          </RealtimeProvider>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { ...view, publish: fixture.publish };
}

test.each(["en", "ar"])(
  "failed import stops loading and can be dismissed without auto-resubmission (%s)",
  async (lang) => {
    localStorage.setItem("musicmute.web.language", lang);
    sessionStorage.setItem(
      "musicmute.web.import.test-user",
      "0123456789abcdef01234567",
    );
    sessionStorage.setItem(
      "musicmute.web.import.test-user.request",
      "old request",
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = page(false, "failed");
    await screen.findByRole("alert");
    expect(container.querySelector(".spinner")).toBeNull();
    expect(screen.getByRole("alert")).not.toHaveTextContent("Request failed");
    expect(container.querySelector(".import-state")).not.toHaveTextContent(
      "Importing source…",
    );
    await userEvent.click(screen.getByRole("button", { name: /Close|إغلاق/ }));
    expect(sessionStorage.getItem("musicmute.web.import.test-user")).toBeNull();
    expect(
      sessionStorage.getItem("musicmute.web.import.test-user.request"),
    ).toBeNull();
    expect(container.querySelector(".import-state")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

test("active imports retain a spinner", async () => {
  sessionStorage.setItem(
    "musicmute.web.import.test-user",
    "0123456789abcdef01234567",
  );
  const { container } = page(false, "downloading");
  await screen.findByText(/Importing source/);
  expect(container.querySelector(".spinner")).not.toBeNull();
});

test.each([
  ["IMPORT_SOURCE_UNAVAILABLE", "importSourceUnavailable"],
  ["IMPORT_UPSTREAM_REFUSED", "importUpstreamRefused"],
  ["IMPORT_DEPENDENCY_FAILED", "importDependencyFailed"],
  ["IMPORT_INVALID_AUDIO", "importInvalidAudio"],
  ["IMPORT_DISK_FULL", "importDiskFull"],
  ["IMPORT_UNSUPPORTED_AUDIO_SOURCE", "importNoAudio"],
])("maps %s without showing raw provider messages", (code, key) => {
  expect(
    friendlyError({ code, message: "secret provider URL" }, (value) => value),
  ).toBe(key);
});

test("URL intake requires rights and imports the selected video from a playlist share", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/processing-policy"))
        return new Response('{"accept_new_jobs":true}', { status: 200 });
      if (url.includes("/jobs?"))
        return new Response('{"items":[],"next_cursor":null}', { status: 200 });
      if (url.endsWith("/media-imports") && init?.method === "POST") {
        requests.push({ url, body: JSON.parse(init.body as string) });
        return new Response(
          '{"import_id":"0123456789abcdef01234567","status":"queued","job_id":null,"error":null}',
          { status: 202 },
        );
      }
      if (url.includes("/media-imports/"))
        return new Response(
          '{"import_id":"0123456789abcdef01234567","status":"queued","job_id":null,"error":null}',
          { status: 200 },
        );
      throw new Error(`Unexpected route: ${url}`);
    }),
  );
  page();
  const user = userEvent.setup();
  expect(screen.getByRole("checkbox", { name: "Trim silence" })).toBeChecked();
  await user.type(
    screen.getByRole("textbox", { name: "Public media URL" }),
    "https://www.youtube.com/watch?v=e6WT8RwRwt4&list=RDe6WT8RwRwt4&start_radio=1",
  );
  await user.click(screen.getByRole("button", { name: "Start import" }));
  expect(screen.getByRole("alert")).toHaveTextContent("rights");
  await user.click(
    screen.getByRole("checkbox", {
      name: "I have the rights to process this audio",
    }),
  );
  await user.click(screen.getByRole("checkbox", { name: "Trim silence" }));
  await user.click(screen.getByRole("button", { name: "Start import" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0].body).toMatchObject({
    url: "https://www.youtube.com/watch?v=e6WT8RwRwt4",
    trim_enabled: false,
  });
  expect(requests[0].body.request_id).toMatch(/^[a-f0-9-]{36}$/);
});

test("audio upload starts with trimming enabled", async () => {
  vi.spyOn(audioPreparation, "inspectDuration").mockResolvedValue(5);
  page();
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Upload audio" }));
  await user.upload(
    screen.getByLabelText("Choose audio file"),
    new File(["audio"], "sample.mp3", { type: "audio/mpeg" }),
  );
  expect(
    await screen.findByRole("checkbox", { name: "Trim silence" }),
  ).toBeChecked();
});

test("ambiguous import write reuses its request ID on retry", async () => {
  const ids: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/processing-policy"))
        return new Response('{"accept_new_jobs":true}', { status: 200 });
      if (url.includes("/jobs?"))
        return new Response('{"items":[],"next_cursor":null}', { status: 200 });
      if (url.endsWith("/media-imports") && init?.method === "POST") {
        ids.push(JSON.parse(init.body as string).request_id);
        return ids.length === 1
          ? new Response('{"code":"SERVICE_UNAVAILABLE"}', { status: 503 })
          : new Response(
              '{"import_id":"0123456789abcdef01234567","status":"queued","job_id":null,"error":null}',
              { status: 202 },
            );
      }
      if (url.includes("/media-imports/"))
        return new Response(
          '{"import_id":"0123456789abcdef01234567","status":"queued","job_id":null,"error":null}',
          { status: 200 },
        );
      throw new Error(`Unexpected route: ${url}`);
    }),
  );
  page();
  const user = userEvent.setup();
  await user.type(
    screen.getByRole("textbox", { name: "Public media URL" }),
    "https://www.youtube.com/watch?v=UXqq0ZvbOnk",
  );
  await user.click(
    screen.getByRole("checkbox", {
      name: "I have the rights to process this audio",
    }),
  );
  await user.click(screen.getByRole("button", { name: "Start import" }));
  await waitFor(() => expect(ids).toHaveLength(1));
  await user.click(screen.getByRole("button", { name: "Start import" }));
  await waitFor(() => expect(ids).toHaveLength(2));
  expect(ids[1]).toBe(ids[0]);
});

test("processing intake stays disabled when policy cannot be loaded", async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/processing-policy"))
      return new Response('{"code":"SERVICE_UNAVAILABLE"}', { status: 503 });
    if (url.includes("/jobs?"))
      return new Response('{"items":[],"next_cursor":null}', { status: 200 });
    throw new Error(`Unexpected route: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  page(true);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Start import" })).toBeDisabled(),
  );
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Processing is unavailable",
    ),
  );
  expect(
    fetchMock.mock.calls.some(([url]) => url.endsWith("/media-imports")),
  ).toBe(false);
});

test("unknown links show unsupported locally without creating an import or retry identity", async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/processing-policy"))
      return new Response('{"accept_new_jobs":true}');
    if (url.includes("/jobs?"))
      return new Response('{"items":[],"next_cursor":null}');
    throw new Error("Unexpected network request");
  });
  vi.stubGlobal("fetch", fetchMock);
  page();
  const user = userEvent.setup();
  await user.type(
    screen.getByRole("textbox", { name: "Public media URL" }),
    "https://unknown.example/audio",
  );
  await user.click(
    screen.getByRole("checkbox", {
      name: "I have the rights to process this audio",
    }),
  );
  await user.click(screen.getByRole("button", { name: "Start import" }));
  expect(screen.getByRole("alert")).toHaveTextContent("not supported");
  expect(
    fetchMock.mock.calls.some(([url]) => url.includes("media-imports")),
  ).toBe(false);
  expect(
    sessionStorage.getItem("musicmute.web.import.test-user.request"),
  ).toBeNull();
});

test("another URL can be submitted while an earlier import is downloading, and both survive reload", async () => {
  const ids = ["0123456789abcdef01234567", "0123456789abcdef01234568"];
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(init?.body as string));
      return new Response(
        JSON.stringify({
          import_id: ids[requests.length - 1],
          status: "queued",
          job_id: null,
          error: null,
        }),
        { status: 202 },
      );
    }),
  );
  const first = page(false, "downloading");
  const user = userEvent.setup();
  const input = screen.getByRole("textbox", { name: "Public media URL" });
  await user.click(
    screen.getByRole("checkbox", {
      name: "I have the rights to process this audio",
    }),
  );
  await user.type(input, "https://youtu.be/UXqq0ZvbOnk");
  await user.click(screen.getByRole("button", { name: "Start import" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(
    await screen.findByRole("button", { name: "Start import" }),
  ).toBeEnabled();
  await user.type(input, "https://youtu.be/dQw4w9WgXcQ");
  await user.click(screen.getByRole("button", { name: "Start import" }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[0].request_id).not.toBe(requests[1].request_id);
  await waitFor(() =>
    expect(
      first.container.querySelectorAll(".import-state .spinner"),
    ).toHaveLength(2),
  );
  expect(
    JSON.parse(sessionStorage.getItem("musicmute.web.import.test-user")!),
  ).toEqual(ids);
  first.unmount();
  const restored = page(false, "downloading");
  await waitFor(() =>
    expect(
      restored.container.querySelectorAll(".import-state .spinner"),
    ).toHaveLength(2),
  );
  expect(requests).toHaveLength(2);
});

test("twenty restored imports remain visible and keep the intake available", async () => {
  const ids = Array.from({ length: 20 }, (_, index) =>
    index.toString(16).padStart(24, "0"),
  );
  sessionStorage.setItem("musicmute.web.import.test-user", JSON.stringify(ids));
  const { container } = page(false, "downloading");
  await waitFor(() =>
    expect(container.querySelectorAll(".import-state .spinner")).toHaveLength(
      20,
    ),
  );
  expect(screen.getByRole("button", { name: "Start import" })).toBeEnabled();
});

test("completed imports offer a job link while preserving the next draft", async () => {
  sessionStorage.setItem(
    "musicmute.web.import.test-user",
    "0123456789abcdef01234567",
  );
  page(false, "submitted");
  const user = userEvent.setup();
  const input = screen.getByRole("textbox", { name: "Public media URL" });
  await user.type(input, "https://youtu.be/dQw4w9WgXcQ");
  expect(await screen.findByRole("link", { name: "Details" })).toHaveAttribute(
    "href",
    "/jobs/0123456789abcdef01234569",
  );
  expect(input).toHaveValue("https://youtu.be/dQw4w9WgXcQ");
  expect(screen.getByRole("button", { name: "Start import" })).toBeEnabled();
});

const failedImportId = "0123456789abcdef01234567";
const retriedImportId = "0123456789abcdef01234568";
const importStorageKey = "musicmute.web.import.test-user";
const retrySource = "https://www.youtube.com/watch?v=UXqq0ZvbOnk";

function failedImport(
  overrides: Partial<MediaImportView> = {},
): MediaImportView {
  return {
    importId: failedImportId,
    sourceTitle: null,
    status: "failed",
    jobId: null,
    error: { code: "IMPORT_DEPENDENCY_FAILED", message: "Source unavailable" },
    sourceUrl: retrySource,
    trimEnabled: false,
    ...overrides,
  };
}

function restoreFailedImport() {
  sessionStorage.setItem(importStorageKey, JSON.stringify([failedImportId]));
}

function importAccepted(id = retriedImportId) {
  return new Response(
    JSON.stringify({
      import_id: id,
      status: "queued",
      job_id: null,
      error: null,
    }),
    { status: 202 },
  );
}

test.each(["en", "ar"])(
  "Try again uses the original link and trim without changing the next draft (%s)",
  async (lang) => {
    localStorage.setItem("musicmute.web.language", lang);
    restoreFailedImport();
    const requests: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      requests.push(JSON.parse(init?.body as string));
      return importAccepted();
    });
    vi.stubGlobal("fetch", fetchMock);
    const view = page(false, "failed", undefined, {
      readImport: (id) =>
        id === failedImportId
          ? failedImport()
          : {
              importId: id,
              sourceTitle: null,
              status: "downloading",
              jobId: null,
              error: null,
            },
    });
    const retry = await screen.findByRole("button", {
      name: /Try again|حاول مرة أخرى/,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    const input = screen.getByRole("textbox");
    await userEvent.type(input, "https://youtu.be/dQw4w9WgXcQ");
    expect(screen.getAllByRole("checkbox")[0]).toBeChecked();
    expect(screen.getAllByRole("checkbox")[1]).not.toBeChecked();
    await userEvent.click(retry);
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      url: retrySource,
      trim_enabled: false,
    });
    expect(requests[0].request_id).toMatch(/^[a-f0-9-]{36}$/);
    await waitFor(() =>
      expect(
        view.container.querySelector(".import-state .spinner"),
      ).not.toBeNull(),
    );
    expect(input).toHaveValue("https://youtu.be/dQw4w9WgXcQ");
    expect(JSON.parse(sessionStorage.getItem(importStorageKey)!)).toEqual([
      retriedImportId,
    ]);
    expect(
      JSON.parse(
        sessionStorage.getItem(
          `${importStorageKey}.source.${retriedImportId}`,
        )!,
      ),
    ).toEqual({
      source: retrySource,
      trimEnabled: false,
      rightsConfirmed: true,
    });
    expect(
      sessionStorage.getItem(`${importStorageKey}.retry.${failedImportId}`),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Try again|حاول مرة أخرى/ }),
    ).not.toBeInTheDocument();
  },
);

test("older snapshots can retry using the saved confirmed source context", async () => {
  restoreFailedImport();
  sessionStorage.setItem(
    `${importStorageKey}.source.${failedImportId}`,
    JSON.stringify({
      source: retrySource,
      trimEnabled: false,
      rightsConfirmed: true,
    }),
  );
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    expect(JSON.parse(init?.body as string)).toMatchObject({
      url: retrySource,
      trim_enabled: false,
    });
    return importAccepted();
  });
  vi.stubGlobal("fetch", fetchMock);
  page(false, "failed");
  await userEvent.click(
    await screen.findByRole("button", { name: "Try again" }),
  );
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
});

test.each([
  ["no context", null],
  [
    "unconfirmed context",
    JSON.stringify({
      source: retrySource,
      trimEnabled: false,
      rightsConfirmed: false,
    }),
  ],
  ["malformed context", "{"],
  [
    "unsupported context",
    JSON.stringify({
      source: "https://private.example/media",
      trimEnabled: false,
      rightsConfirmed: true,
    }),
  ],
])(
  "a legacy failed card with %s cannot start provider work",
  async (_name, context) => {
    restoreFailedImport();
    if (context)
      sessionStorage.setItem(
        `${importStorageKey}.source.${failedImportId}`,
        context,
      );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    page(false, "failed");
    await screen.findByRole("button", { name: "Close" });
    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

test.each([
  "OFFLINE",
  "SERVICE_UNAVAILABLE",
  "RATE_LIMITED",
  "IMPORT_QUEUE_FULL",
  "IMPORT_DEPENDENCY_FAILED",
  "IMPORT_DISK_FULL",
  "IMPORT_UPSTREAM_REFUSED",
  "IMPORT_SOURCE_UNAVAILABLE",
  "IMPORT_DISABLED",
  "PROCESSING_UNAVAILABLE",
])("matches Android's explicit retry eligibility for %s", async (code) => {
  restoreFailedImport();
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  page(false, "failed", undefined, {
    readImport: () => failedImport({ error: { code, message: "Failed" } }),
  });
  expect(
    await screen.findByRole("button", { name: "Try again" }),
  ).toBeEnabled();
  expect(fetchMock).not.toHaveBeenCalled();
});

test.each([
  "IMPORT_ACQUISITION_EXHAUSTED",
  "IMPORT_INVALID_AUDIO",
  "IMPORT_SINGLE_ITEM_REQUIRED",
  "IMPORT_INVALID_URL",
  "UNKNOWN",
])(
  "does not offer acquisition retries for permanent or unclassified %s errors",
  async (code) => {
    restoreFailedImport();
    page(false, "failed", undefined, {
      readImport: () => failedImport({ error: { code, message: "Failed" } }),
    });
    await screen.findByRole("button", { name: "Close" });
    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
  },
);

test("a failed import already linked to a job cannot create another import", async () => {
  restoreFailedImport();
  page(false, "failed", undefined, {
    readImport: () => failedImport({ jobId: "0123456789abcdef01234569" }),
  });
  await screen.findByRole("button", { name: "Close" });
  expect(
    screen.queryByRole("button", { name: "Try again" }),
  ).not.toBeInTheDocument();
});

test.each(["account", "policy"])(
  "Try again respects %s admission restrictions",
  async (restriction) => {
    restoreFailedImport();
    if (restriction === "account")
      mockAuth.session = { access: { allowed: false } };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    page(false, "failed", undefined, {
      readImport: () => failedImport(),
      acceptNewJobs: restriction !== "policy",
    });
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(retry).toBeDisabled();
    await userEvent.click(retry);
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

test("rapid retry taps create one admission and keep the recoverable card until its receipt", async () => {
  restoreFailedImport();
  let complete!: (response: Response) => void;
  const fetchMock = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const view = page(false, "failed", undefined, {
    readImport: (id) =>
      id === failedImportId
        ? failedImport()
        : {
            importId: id,
            sourceTitle: null,
            status: "queued",
            jobId: null,
            error: null,
          },
  });
  const retry = await screen.findByRole("button", { name: "Try again" });
  fireEvent.click(retry);
  fireEvent.click(retry);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(retry).toBeDisabled();
  expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  expect(view.container.querySelector(".import-state")).toHaveAttribute(
    "data-reload-blocked",
    "true",
  );
  expect(JSON.parse(sessionStorage.getItem(importStorageKey)!)).toEqual([
    failedImportId,
  ]);
  await act(async () => complete(importAccepted()));
  await waitFor(() =>
    expect(JSON.parse(sessionStorage.getItem(importStorageKey)!)).toEqual([
      retriedImportId,
    ]),
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("uncertain retry admission retains the same UUID and failed card through refresh", async () => {
  restoreFailedImport();
  const requests: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    requests.push(JSON.parse(init?.body as string));
    return requests.length === 1
      ? new Response(
          '{"code":"SERVICE_UNAVAILABLE","message":"private provider secret"}',
          { status: 503 },
        )
      : importAccepted();
  });
  vi.stubGlobal("fetch", fetchMock);
  const options: PageOptions = {
    readImport: (id) =>
      id === failedImportId
        ? failedImport()
        : {
            importId: id,
            sourceTitle: null,
            status: "submitted",
            jobId: "0123456789abcdef01234569",
            error: null,
          },
  };
  const first = page(false, "failed", undefined, options);
  await userEvent.click(
    await screen.findByRole("button", { name: "Try again" }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled(),
  );
  expect(screen.getAllByRole("alert")).toHaveLength(2);
  expect(first.container).not.toHaveTextContent("private provider secret");
  expect(JSON.parse(sessionStorage.getItem(importStorageKey)!)).toEqual([
    failedImportId,
  ]);
  const recovery = JSON.parse(
    sessionStorage.getItem(`${importStorageKey}.retry.${failedImportId}`)!,
  );
  expect(recovery.requestId).toBe(requests[0].request_id);
  first.unmount();
  page(false, "failed", undefined, options);
  const retry = await screen.findByRole("button", { name: "Try again" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await userEvent.click(retry);
  expect(await screen.findByRole("link", { name: "Details" })).toHaveAttribute(
    "href",
    "/jobs/0123456789abcdef01234569",
  );
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(JSON.parse(sessionStorage.getItem(importStorageKey)!)).toEqual([
    retriedImportId,
  ]);
  expect(
    sessionStorage.getItem(`${importStorageKey}.retry.${failedImportId}`),
  ).toBeNull();
});

test("a late retry receipt after switching accounts cannot write either account's imports", async () => {
  restoreFailedImport();
  let complete!: (response: Response) => void;
  let signal: AbortSignal | undefined;
  const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    signal = init?.signal as AbortSignal;
    return new Promise<Response>((resolve) => {
      complete = resolve;
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const first = page(false, "failed", undefined, {
    readImport: () => failedImport(),
  });
  await userEvent.click(
    await screen.findByRole("button", { name: "Try again" }),
  );
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  first.unmount();
  expect(signal?.aborted).toBe(true);
  mockAuth.user = { uid: "another-user" };
  page();
  await act(async () => complete(importAccepted()));
  expect(JSON.parse(sessionStorage.getItem(importStorageKey)!)).toEqual([
    failedImportId,
  ]);
  expect(
    sessionStorage.getItem("musicmute.web.import.another-user"),
  ).toBeNull();
  expect(
    sessionStorage.getItem(`${importStorageKey}.source.${retriedImportId}`),
  ).toBeNull();
  expect(
    sessionStorage.getItem(`${importStorageKey}.retry.${failedImportId}`),
  ).not.toBeNull();
});

test("out-of-order retry and new-import receipts preserve both independent imports", async () => {
  restoreFailedImport();
  const completions: Array<(response: Response) => void> = [];
  const fetchMock = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        completions.push(resolve);
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const view = page(false, "failed", undefined, {
    readImport: (id) =>
      id === failedImportId
        ? failedImport()
        : {
            importId: id,
            sourceTitle: null,
            status: "downloading",
            jobId: null,
            error: null,
          },
  });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Try again" }));
  await user.type(screen.getByRole("textbox"), "https://youtu.be/dQw4w9WgXcQ");
  await user.click(
    screen.getByRole("checkbox", {
      name: "I have the rights to process this audio",
    }),
  );
  await user.click(screen.getByRole("button", { name: "Start import" }));
  await waitFor(() => expect(completions).toHaveLength(2));
  const anotherImportId = "0123456789abcdef0123456a";
  await act(async () => completions[1](importAccepted(anotherImportId)));
  await act(async () => completions[0](importAccepted()));
  await waitFor(() =>
    expect(
      view.container.querySelectorAll(".import-state .spinner"),
    ).toHaveLength(2),
  );
  expect(JSON.parse(sessionStorage.getItem(importStorageKey)!)).toEqual([
    retriedImportId,
    anotherImportId,
  ]);
});

test("two failed cards retry independently and preserve both reverse-order receipts", async () => {
  const secondFailedId = "0123456789abcdef0123456a";
  const secondRetriedId = "0123456789abcdef0123456b";
  const secondSource = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  sessionStorage.setItem(
    importStorageKey,
    JSON.stringify([failedImportId, secondFailedId]),
  );
  const requests: Record<string, unknown>[] = [];
  const completions: Array<(response: Response) => void> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(init?.body as string));
      return new Promise<Response>((resolve) => {
        completions.push(resolve);
      });
    }),
  );
  const view = page(false, "failed", undefined, {
    readImport: (id) => {
      if (id === failedImportId) return failedImport();
      if (id === secondFailedId)
        return failedImport({
          importId: id,
          sourceUrl: secondSource,
          trimEnabled: true,
        });
      return {
        importId: id,
        sourceTitle: null,
        status: "downloading",
        jobId: null,
        error: null,
      };
    },
  });
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: "Try again" })).toHaveLength(
      2,
    ),
  );
  const retries = screen.getAllByRole("button", { name: "Try again" });
  fireEvent.click(retries[0]);
  fireEvent.click(retries[1]);
  await waitFor(() => expect(completions).toHaveLength(2));
  expect(requests[0]).toMatchObject({ url: retrySource, trim_enabled: false });
  expect(requests[1]).toMatchObject({ url: secondSource, trim_enabled: true });
  expect(requests[0].request_id).not.toBe(requests[1].request_id);
  await act(async () => completions[1](importAccepted(secondRetriedId)));
  await act(async () => completions[0](importAccepted()));
  await waitFor(() =>
    expect(
      view.container.querySelectorAll(".import-state .spinner"),
    ).toHaveLength(2),
  );
  expect(JSON.parse(sessionStorage.getItem(importStorageKey)!)).toEqual([
    retriedImportId,
    secondRetriedId,
  ]);
});
