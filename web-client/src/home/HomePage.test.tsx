import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import { ApiClient, ApiError } from "../api/client";
import { friendlyError, I18nProvider } from "../i18n";
import { HomePage } from "./HomePage";
import * as audioPreparation from "./audio-preparation";
import { RealtimeProvider } from "../realtime/RealtimeProvider";
import { realtimeFixture } from "../../tests/realtime-fixture";

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
});

function page(
  policyFailure = false,
  importStatus = "queued",
  importErrorCode = "IMPORT_SOURCE_UNAVAILABLE",
) {
  const { client } = realtimeFixture((resource) => {
    if (resource === "policy") {
      if (policyFailure) throw new ApiError(503, "SERVICE_UNAVAILABLE");
      return {
        acceptNewJobs: true,
        limits: {
          maxDurationSeconds: 1200,
          maxPreparedAudioBytes: 50_000_000,
          maxLocalSourceBytes: 200_000_000,
        },
      };
    }
    if (resource === "jobs") return { items: [], nextCursor: null };
    if (resource === "import")
      return {
        importId: "0123456789abcdef01234567",
        status: importStatus,
        jobId: null,
        error: importStatus === "failed" ? { code: importErrorCode } : null,
      };
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
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <MemoryRouter>
          <RealtimeProvider client={client}>
            <HomePage />
          </RealtimeProvider>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
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

test("URL intake requires rights and sends the reviewed trim option", async () => {
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
    "https://www.youtube.com/watch?v=UXqq0ZvbOnk",
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
    url: "https://www.youtube.com/watch?v=UXqq0ZvbOnk",
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
