import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { RealtimeProvider } from "../realtime/RealtimeProvider";
import { realtimeFixture } from "../../tests/realtime-fixture";
import { HomePage } from "../home/HomePage";
import { LibraryPage } from "../library/LibraryPage";
import { JobsPage } from "./JobsUI";

vi.mock("../auth/AuthProvider", () => ({
  useSignedIn: () => ({
    api: {},
    user: { uid: "owner" },
    session: { access: { allowed: true } },
  }),
  useAuth: () => ({ retry: vi.fn() }),
}));
vi.mock("../player/PlayerProvider", () => ({
  usePlayer: () => ({ play: vi.fn() }),
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});
const job = (id: string, status = "ready") => ({
  id,
  displayName: id,
  status,
  createdAt: "2026-09-28T10:35:00Z",
  canDownloadOutput: status === "ready",
});
function mount(
  view: React.ReactNode,
  read: Parameters<typeof realtimeFixture>[0],
) {
  const fixture = realtimeFixture(read);
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={cache}>
      <I18nProvider>
        <MemoryRouter>
          <RealtimeProvider client={fixture.client}>{view}</RealtimeProvider>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return fixture;
}
test.each(["home", "jobs"])(
  "%s shows active jobs and hides terminal history on reopening",
  async (view) => {
    mount(view === "home" ? <HomePage /> : <JobsPage />, (resource) =>
      resource === "policy"
        ? { acceptNewJobs: true }
        : {
            items: [
              job("Finished song"),
              job("Failed song", "failed"),
              job("Cancelled song", "cancelled"),
              job("Current song", "processing"),
            ],
            nextCursor: null,
          },
    );
    await screen.findByText("Current song");
    expect(screen.queryByText("Finished song")).toBeNull();
    expect(screen.queryByText("Failed song")).toBeNull();
    expect(screen.queryByText("Cancelled song")).toBeNull();
    expect(screen.getByText(/Sep 28, 2026/)).toBeInTheDocument();
  },
);
test("library loads beyond ten pages without losing earlier songs", async () => {
  const requests: Record<string, string>[] = [];
  mount(<LibraryPage />, (_, params) => {
    requests.push(params);
    const index = Number(params.cursor ?? 0);
    return {
      items: [job(`Song ${index}`)],
      nextCursor: index < 11 ? String(index + 1) : null,
    };
  });
  await screen.findByText("Song 0");
  for (let index = 1; index <= 11; index++) {
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText(`Song ${index}`);
  }
  expect(screen.getByText("Song 0")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  expect(requests.every((params) => params.status === "ready")).toBe(true);
});
test("completion removes a current card without a deletion request", async () => {
  let status = "processing";
  const fixture = mount(<JobsPage />, () => ({
    items: [job("Current song", status)],
    nextCursor: null,
  }));
  await screen.findByText("Current song");
  status = "ready";
  await act(async () => {
    fixture.publish();
  });
  await waitFor(() => expect(screen.queryByText("Current song")).toBeNull());
});
