import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { LibraryPage } from "./LibraryPage";

const { play, jobs } = vi.hoisted(() => ({
  play: vi.fn(),
  jobs: [
    {
      id: "alpha",
      displayName: "Alpha",
      status: "ready",
      createdAt: "2026-10-01",
    },
    {
      id: "beta",
      displayName: "Beta",
      status: "ready",
      createdAt: "2026-10-02",
    },
    {
      id: "gamma",
      displayName: "Gamma",
      status: "ready",
      createdAt: "2026-10-03",
    },
  ],
}));
vi.mock("../auth/AuthProvider", () => ({
  useSignedIn: () => ({ api: {}, user: { uid: "owner" } }),
}));
vi.mock("../player/PlayerProvider", () => ({ usePlayer: () => ({ play }) }));
vi.mock("../jobs/JobsUI", () => ({
  useJobs: () => ({ data: { pages: [{ items: jobs }] }, isPending: false }),
}));
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

test("one click filters stars, Most Played orders rows and playback queue, and options include its sort", () => {
  localStorage.setItem(
    "musicmute.web.library.owner",
    JSON.stringify({
      favorites: ["alpha", "gamma"],
      hidden: [],
      playCounts: { alpha: 5, beta: 10 },
    }),
  );
  render(
    <I18nProvider>
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>
    </I18nProvider>,
  );
  const checkbox = screen.getByRole("checkbox", { name: "Show starred" });
  fireEvent.click(checkbox);
  expect(checkbox).toBeChecked();
  expect(screen.queryByRole("link", { name: "Beta" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Most played" }));
  expect(screen.queryByRole("link", { name: "Gamma" })).toBeNull();
  fireEvent.click(checkbox);
  const rows = screen.getAllByRole("article");
  expect(
    within(rows[0]!).getByRole("link", { name: "Beta" }),
  ).toBeInTheDocument();
  fireEvent.click(within(rows[0]!).getByRole("button", { name: "Play" }));
  expect(play).toHaveBeenCalledWith(jobs[1], [jobs[1], jobs[0]]);
  expect(screen.getByRole("combobox", { name: "Sort tracks" })).toHaveValue(
    "mostPlayed",
  );
  fireEvent.click(screen.getByRole("button", { name: "All" }));
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "mostPlayed" },
  });
  expect(screen.getAllByRole("article")).toHaveLength(3);
});

test("Arabic exposes localized checkbox and Most Played tab", () => {
  localStorage.setItem("musicmute.web.language", "ar");
  render(
    <I18nProvider>
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>
    </I18nProvider>,
  );
  expect(
    screen.getByRole("checkbox", { name: "عرض المفضلة" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "الأكثر تشغيلًا" }));
  expect(
    screen.getByText("شغّل مقطعًا لتظهر هنا أغانيك الأكثر تشغيلًا."),
  ).toBeInTheDocument();
});
