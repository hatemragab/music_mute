import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import { ApiClient } from "../api/client";
import { I18nProvider } from "../i18n";
import { HomePage } from "./HomePage";

const mockAuth = vi.hoisted(() => ({
  api: null as unknown,
  user: { uid: "test-user" },
  session: { access: { allowed: true } },
}));
vi.mock("../auth/AuthProvider", () => ({ useSignedIn: () => mockAuth }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

function page() {
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
          <HomePage />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

test("URL intake requires rights and sends the reviewed trim option", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/processing-policy"))
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
  await user.type(
    screen.getByRole("textbox", { name: "Public media URL" }),
    "https://example.com/audio",
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
    url: "https://example.com/audio",
    trim_enabled: false,
  });
  expect(requests[0].body.request_id).toMatch(/^[a-f0-9-]{36}$/);
});

test("ambiguous import write reuses its request ID on retry", async () => {
  const ids: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/processing-policy"))
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
    "https://example.com/audio",
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
    if (url.endsWith("/processing-policy"))
      return new Response('{"code":"SERVICE_UNAVAILABLE"}', { status: 503 });
    if (url.includes("/jobs?"))
      return new Response('{"items":[],"next_cursor":null}', { status: 200 });
    throw new Error(`Unexpected route: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  page();
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
