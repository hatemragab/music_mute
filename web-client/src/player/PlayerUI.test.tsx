import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { PlayerPage } from "./PlayerUI";

const player = {
  current: {
    id: "6abaade2a3f12dc9ed43c129",
    displayName: null,
    sourceTitle: null,
    canDownloadInput: false,
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
    },
    {
      id: "named",
      displayName: "Named song",
      sourceTitle: null,
      canDownloadInput: true,
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
