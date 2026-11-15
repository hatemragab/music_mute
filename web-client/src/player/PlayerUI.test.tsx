import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { MiniPlayer, PlayerPage } from "./PlayerUI";

const player = {
  current: {
    id: "6abaade2a3f12dc9ed43c129",
    displayName: null,
    sourceTitle: null,
    canDownloadInput: false,
    thumbnailUrl: null as string | null,
  },
  playing: false,
  time: 4,
  duration: 90,
  error: null,
  queue: [
    {
      id: "6abaade2a3f12dc9ed43c129",
      displayName: null,
      sourceTitle: null,
      canDownloadInput: false,
      thumbnailUrl: null as string | null,
    },
    {
      id: "named",
      displayName: "Named song",
      sourceTitle: null,
      canDownloadInput: true,
      thumbnailUrl: null as string | null,
    },
  ],
  speed: 1,
  volume: 1,
  repeat: "off" as const,
  shuffle: false,
  autoNext: true,
  original: false,
  loop: null,
  play: vi.fn(),
  toggle: vi.fn(),
  seek: vi.fn(),
  next: vi.fn(),
  previous: vi.fn(),
  setSpeed: vi.fn(),
  setVolume: vi.fn(),
  setRepeat: vi.fn(),
  setShuffle: vi.fn(),
  setAutoNext: vi.fn(),
  toggleLoop: vi.fn(),
  selectOriginal: vi.fn(),
  removeFromQueue: vi.fn(),
};

vi.mock("./PlayerProvider", () => ({
  usePlayer: () => player,
}));
vi.mock("../auth/AuthProvider", () => ({
  useSignedIn: () => ({ api: {}, user: { uid: "owner" } }),
}));
vi.mock("../library/preferences", () => ({
  useLibraryPreferences: () => ({
    preferences: { favorites: [], hidden: [] },
    toggle: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  player.current = {
    id: "6abaade2a3f12dc9ed43c129",
    displayName: null,
    sourceTitle: null,
    canDownloadInput: false,
    thumbnailUrl: null,
  };
  player.queue.forEach((job) => {
    job.thumbnailUrl = null;
  });
  vi.clearAllMocks();
});

function artworkView(full: boolean) {
  return (
    <I18nProvider>
      <MemoryRouter initialEntries={["/library"]}>
        {full ? <PlayerPage /> : <MiniPlayer />}
      </MemoryRouter>
    </I18nProvider>
  );
}

const originalThumbnail = "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg";
const changedThumbnail = "https://i.ytimg.com/vi/jNQXAC9IVRw/maxresdefault.jpg";

test.each([true, false])(
  "%s full player uses the original artwork with a loading/error placeholder and eager no-referrer image",
  (full) => {
    player.current = { ...player.current, thumbnailUrl: originalThumbnail };
    const { container } = render(artworkView(full));
    const cover = container.querySelector(
      full ? ".player-art" : ".mini-cover",
    )!;
    const image = cover.querySelector("img")!;
    expect(image).toHaveAttribute("src", originalThumbnail);
    expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(image).toHaveAttribute("loading", "eager");
    expect(image).toHaveAttribute("alt", "");
    expect(cover).toHaveAttribute("aria-hidden", "true");
    expect(cover.querySelector("svg")).not.toBeNull();
    fireEvent.load(image);
    expect(image).toHaveClass("loaded");
    expect(cover.querySelector("svg")).toBeNull();
    fireEvent.error(image);
    expect(cover.querySelector("img")).toBeNull();
    expect(cover.querySelector("svg")).not.toBeNull();
  },
);

test.each([
  null,
  "https://example.invalid/image.jpg",
  "http://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg",
])(
  "missing or invalid player artwork keeps both existing placeholders: %s",
  (url) => {
    player.current = { ...player.current, thumbnailUrl: url };
    const { container } = render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/library"]}>
          <PlayerPage />
          <MiniPlayer />
        </MemoryRouter>
      </I18nProvider>,
    );
    expect(container.querySelector(".player-art img")).toBeNull();
    expect(container.querySelector(".mini-cover img")).toBeNull();
    expect(container.querySelector(".player-art svg")).not.toBeNull();
    expect(container.querySelector(".mini-cover svg")).not.toBeNull();
  },
);

test.each([true, false])(
  "%s full player resets stale or failed artwork when a URL or track changes",
  (full) => {
    player.current = { ...player.current, thumbnailUrl: originalThumbnail };
    const { container, rerender } = render(artworkView(full));
    const selector = full ? ".player-art" : ".mini-cover";
    const first = container.querySelector(`${selector} img`)!;
    fireEvent.load(first);
    player.current = { ...player.current, thumbnailUrl: changedThumbnail };
    rerender(artworkView(full));
    const changed = container.querySelector(`${selector} img`)!;
    expect(changed).toHaveAttribute("src", changedThumbnail);
    expect(changed).not.toHaveClass("loaded");
    fireEvent.load(first);
    expect(changed).not.toHaveClass("loaded");
    fireEvent.error(changed);
    expect(container.querySelector(`${selector} img`)).toBeNull();
    player.current = { ...player.current, id: "other-video" };
    rerender(artworkView(full));
    const switched = container.querySelector(`${selector} img`)!;
    expect(switched).toHaveAttribute("src", changedThumbnail);
    expect(switched).not.toHaveClass("loaded");
    fireEvent.load(switched);
    expect(switched).toHaveClass("loaded");
    player.current = { ...player.current, thumbnailUrl: null };
    rerender(artworkView(full));
    expect(container.querySelector(`${selector} img`)).toBeNull();
    expect(container.querySelector(`${selector} svg`)).not.toBeNull();
  },
);

test("Up Next uses each track's own lazy artwork and leaves missing thumbnails on the music icon", () => {
  player.current = { ...player.current, thumbnailUrl: originalThumbnail };
  player.queue[1]!.thumbnailUrl = changedThumbnail;
  const { container } = render(artworkView(true));
  const rows = container.querySelectorAll(".queue-track");
  expect(rows[0]!.querySelector(".queue-cover img")).toBeNull();
  expect(rows[0]!.querySelector(".queue-cover svg")).not.toBeNull();
  const image = rows[1]!.querySelector(".queue-cover img")!;
  expect(image).toHaveAttribute("src", changedThumbnail);
  expect(image).toHaveAttribute("loading", "lazy");
  fireEvent.load(image);
  expect(rows[1]!.querySelector(".queue-cover svg")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Named song" }),
  ).toBeInTheDocument();
});

test("player queue uses a title instead of a raw id and keeps skip controls", () => {
  render(
    <I18nProvider>
      <MemoryRouter>
        <PlayerPage />
      </MemoryRouter>
    </I18nProvider>,
  );
  expect(screen.getAllByText("Untitled track").length).toBeGreaterThan(0);
  expect(screen.getByText("Named song")).toBeInTheDocument();
  expect(screen.queryByText("6abaade2a3f12dc9ed43c129")).toBeNull();
  expect(
    screen.getAllByRole("button", { name: "Next" }).length,
  ).toBeGreaterThan(0);
  expect(screen.getByRole("button", { name: "Loop 15 seconds" })).toBeEnabled();
  expect(screen.getByText("Now playing")).toBeInTheDocument();
});
