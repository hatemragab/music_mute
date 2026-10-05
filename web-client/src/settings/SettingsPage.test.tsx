import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";
import { realtimeFixture } from "../../tests/realtime-fixture";
import { I18nProvider } from "../i18n";
import { RealtimeProvider } from "../realtime/RealtimeProvider";
import { SettingsPage } from "./SettingsPage";

const retry = vi.hoisted(() => vi.fn());
vi.mock("../auth/AuthProvider", () => ({
  useSignedIn: () => ({ user: { uid: "test-user" } }),
  useAuth: () => ({ retry }),
}));
vi.mock("../config", () => ({
  readConfig: () => ({ apiOrigin: "https://api.example.com" }),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

test("zero processing quotas render and full allowances arrive by realtime snapshot without HTTP reads", async () => {
  localStorage.setItem("musicmute.web.language", "en");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  let usage = {
    processing: { limitSeconds: 0, usedSeconds: 3, remainingSeconds: 0 },
    availability: {
      status: "blocked",
      reason: "monthly_limit_reached" as string | null,
    },
    period: { nextResetAt: "2026-10-01T00:00:00.000Z" },
    storage: { retainedBytes: 0, limitBytes: 0 },
  };
  const fixture = realtimeFixture((resource) => {
    expect(resource).toBe("usage");
    return usage;
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        })
      }
    >
      <I18nProvider>
        <MemoryRouter>
          <RealtimeProvider client={fixture.client}>
            <SettingsPage />
          </RealtimeProvider>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
  expect(
    await screen.findByText("Processing: 3 / 0 seconds"),
  ).toBeInTheDocument();
  expect(screen.getByRole("progressbar")).toHaveAttribute("max", "1");
  expect(screen.getByText("monthly_limit_reached")).toBeInTheDocument();

  usage = {
    ...usage,
    processing: { limitSeconds: 4, usedSeconds: 3, remainingSeconds: 1 },
    availability: { status: "available", reason: null },
    storage: { retainedBytes: 0, limitBytes: 4 },
  };
  await act(async () => {
    await fixture.publish();
  });
  expect(
    await screen.findByText("Processing: 3 / 4 seconds"),
  ).toBeInTheDocument();
  expect(screen.getByRole("progressbar")).toHaveAttribute("max", "4");
  expect(screen.queryByText("monthly_limit_reached")).not.toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "See macOS downloads" }),
  ).toHaveAttribute("href", "https://music-mute.com/#downloads");
  expect(
    screen.getByRole("link", { name: "See macOS downloads" }),
  ).toHaveAttribute("rel", "noopener noreferrer");
  expect(fetch).not.toHaveBeenCalled();
});
