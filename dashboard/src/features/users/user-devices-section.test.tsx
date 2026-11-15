import { useEffect, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/api-client";
import { formatDateTime } from "@/lib/format";
import { Context } from "@/realtime/hooks";
import { createDashboardFixture } from "@/test/dashboard-fixtures";
import { realtimeFixture } from "@/test/realtime-fixture";
import { realtimeResourcePath } from "@/test/realtime-resource-path";
import type { AdminUserDevice, AdminUserDevicePage } from "./user-device-types";
import { UserDevicesSection } from "./user-devices-section";

const mocks = vi.hoisted(() => ({ can: vi.fn() }));
vi.mock("@/auth/admin-session", () => ({
  useAdminSession: () => ({ can: mocks.can }),
}));

function device(overrides: Partial<AdminUserDevice> = {}): AdminUserDevice {
  return {
    installationId: "fixture-android-installation",
    platform: "android",
    deviceModel: "Pixel 9 Pro",
    osVersion: "Android 16",
    appVersion: "1.2.3",
    buildNumber: 42,
    metadataRevision: 7,
    firstSeenAt: "2026-08-10T10:00:00.000Z",
    lastSeenAt: "2026-10-09T12:00:00.000Z",
    lastAuthenticatedAt: "2026-10-09T11:30:00.000Z",
    historyHiddenAt: "2026-10-01T10:00:00.000Z",
    sessionStatus: "signed_out",
    location: {
      country: "EG",
      continent: "AF",
      region: "Cairo Governorate",
      regionCode: "C",
      city: "Cairo",
      postalCode: "11511",
      metroCode: "fixture-metro",
      timezone: "Africa/Cairo",
      latitude: "30.0444",
      longitude: "31.2357",
      source: "cloudflare",
      observedAt: "2026-10-09T11:45:00.000Z",
    },
    versionHistory: [
      {
        appVersion: "1.2.2",
        buildNumber: 40,
        metadataRevision: 6,
        observedAt: "2026-09-10T10:00:00.000Z",
      },
      {
        appVersion: "1.2.3",
        buildNumber: 42,
        metadataRevision: 7,
        observedAt: "2026-10-09T11:40:00.000Z",
      },
    ],
    ...overrides,
  };
}

const page = (
  items: AdminUserDevice[],
  nextCursor: string | null = null,
): AdminUserDevicePage => ({
  items,
  nextCursor,
  asOf: "2026-10-09T12:15:00.000Z",
});

const cleanups: Array<() => void> = [];
function setup(
  read: Parameters<typeof realtimeFixture>[0],
  userId = "first-user",
) {
  const fixture = realtimeFixture(read);
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Provider({ children }: { children: ReactNode }) {
    useEffect(() => {
      fixture.client.start();
      return () => fixture.client.stop();
    }, []);
    return (
      <QueryClientProvider client={cache}>
        <Context.Provider value={fixture.client}>{children}</Context.Provider>
      </QueryClientProvider>
    );
  }
  const node = (id: string) => (
    <Provider>
      <UserDevicesSection userId={id} />
    </Provider>
  );
  const view = render(node(userId));
  cleanups.push(() => {
    fixture.client.stop();
    cache.clear();
  });
  return {
    ...fixture,
    ...view,
    changeUser: (id: string) => view.rerender(node(id)),
  };
}

function field(card: HTMLElement, label: string) {
  const term = within(card).getByText(label, { selector: "dt" });
  return term.nextElementSibling as HTMLElement;
}

beforeEach(() => {
  mocks.can.mockReturnValue(true);
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("user device observations", () => {
  it("shows an overview and expands every stored device, location and version field", async () => {
    const data = device();
    const read = vi.fn().mockResolvedValue(page([data]));
    setup(read);
    const card = await screen.findByRole("article", {
      name: "Pixel 9 Pro device",
    });
    expect(field(card, "App version")).toHaveTextContent(
      "Version 1.2.3 · Build 42",
    );
    expect(field(card, "Country / city")).toHaveTextContent("Egypt (EG)Cairo");
    expect(field(card, "Last seen")).toHaveTextContent(
      formatDateTime(data.lastSeenAt),
    );
    expect(field(card, "Session")).toHaveTextContent("Signed out");
    expect(
      screen.getByText(/Last seen does not mean a device is currently online/),
    ).toBeInTheDocument();
    const summary = within(card).getByText("View device details");
    await userEvent.click(summary);
    expect(summary.closest("details")).toHaveAttribute("open");
    for (const [label, value] of Object.entries({
      "Installation ID": data.installationId,
      Platform: "Android",
      "Device model": "Pixel 9 Pro",
      "Operating system version": "Android 16",
      "Metadata revision": "7",
      "First seen": formatDateTime(data.firstSeenAt),
      "Last recorded authentication": formatDateTime(data.lastAuthenticatedAt),
      "User history visibility": "Hidden from user history",
      "History hidden at": formatDateTime(data.historyHiddenAt),
      Country: "Egypt (EG)",
      "Continent code": "AF",
      Region: "Cairo Governorate",
      "Region code": "C",
      City: "Cairo",
      "Postal code": "11511",
      "Metro code": "fixture-metro",
      Timezone: "Africa/Cairo",
      Latitude: "30.0444",
      Longitude: "31.2357",
      "Location source": "Cloudflare",
      "Location observed": formatDateTime(data.location!.observedAt),
    }))
      expect(field(card, label)).toHaveTextContent(value);
    const history = within(card).getByRole("table", {
      name: "App version history",
    });
    expect(within(history).getAllByRole("row")).toHaveLength(3);
    expect(within(history).getAllByRole("row")[1]).toHaveTextContent(
      "1.2.2406",
    );
    expect(within(history).getAllByRole("row")[2]).toHaveTextContent(
      "1.2.3427",
    );
    expect(read).toHaveBeenCalledWith("admin.user_devices", {
      id: "first-user",
      limit: "20",
    });
  });

  it("renders Windows desktop identity and numeric build without turning device history into worker approval or a download", async () => {
    const data = device({
      installationId: "fixture-windows-installation",
      platform: "windows",
      deviceModel: "Windows fixture PC",
      osVersion: "10.0.19045",
      appVersion: "0.1.3",
      buildNumber: 42,
      historyHiddenAt: null,
      location: null,
      versionHistory: [],
    });
    const read = vi.fn(async () => page([data]));
    setup(read);
    const card = await screen.findByRole("article", {
      name: "Windows fixture PC device",
    });
    expect(within(card).getAllByText("Windows", { exact: true })).toHaveLength(
      2,
    );
    await userEvent.click(within(card).getByText("View device details"));
    expect(field(card, "Platform")).toHaveTextContent("Windows");
    expect(field(card, "Operating system version")).toHaveTextContent(
      "10.0.19045",
    );
    expect(field(card, "Installation ID")).toHaveTextContent(
      data.installationId,
    );
    expect(field(card, "App version")).toHaveTextContent(
      "Version 0.1.3 · Build 42",
    );
    expect(
      within(card).queryByRole("link", { name: /download|installer/iu }),
    ).not.toBeInTheDocument();
    expect(
      within(card).queryByText(/qualified DirectML|worker approval/iu),
    ).not.toBeInTheDocument();
    expect(read).toHaveBeenCalledWith("admin.user_devices", {
      id: "first-user",
      limit: "20",
    });
  });

  it("keeps unknown sessions and missing location, model and authentication explicit", async () => {
    setup(async () =>
      page([
        device({
          installationId: "fixture-browser-installation",
          platform: "web",
          deviceModel: null,
          location: null,
          lastAuthenticatedAt: null,
          historyHiddenAt: null,
          sessionStatus: "unknown",
          versionHistory: [],
        }),
      ]),
    );
    const card = await screen.findByRole("article", { name: "Web device" });
    expect(
      within(card).getByText(/Browser-profile installation/),
    ).toBeInTheDocument();
    expect(field(card, "Session")).toHaveTextContent("Unknown");
    expect(field(card, "Country / city")).toHaveTextContent(
      "UnknownCity unknown",
    );
    await userEvent.click(within(card).getByText("View device details"));
    expect(field(card, "Device model")).toHaveTextContent("Not available");
    expect(field(card, "Last recorded authentication")).toHaveTextContent(
      "Not available",
    );
    expect(field(card, "History hidden at")).toHaveTextContent("Not available");
    expect(field(card, "User history visibility")).toHaveTextContent(
      "Visible to user",
    );
    expect(
      within(card).getByText("No connection location was recorded."),
    ).toBeInTheDocument();
    expect(
      within(card).getByText("No recorded app version changes."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Online", { exact: true }),
    ).not.toBeInTheDocument();
  });

  it("shows nullable fields within a recorded location without inventing values", async () => {
    const location = device().location!;
    setup(async () =>
      page([
        device({
          location: {
            ...location,
            country: null,
            continent: null,
            region: null,
            regionCode: null,
            city: null,
            postalCode: null,
            metroCode: null,
            timezone: null,
            latitude: null,
            longitude: null,
          },
        }),
      ]),
    );
    const card = await screen.findByRole("article");
    await userEvent.click(within(card).getByText("View device details"));
    for (const label of ["Country", "Continent code", "City"])
      expect(field(card, label)).toHaveTextContent("Unknown");
    for (const label of [
      "Region",
      "Region code",
      "Postal code",
      "Metro code",
      "Timezone",
      "Latitude",
      "Longitude",
    ])
      expect(field(card, label)).toHaveTextContent("Not available");
  });

  it("replaces the current full snapshot and receives no recurring or focus HTTP reads", async () => {
    let saved = page([device()]);
    const read = vi.fn(async () => saved);
    const fetch = vi.spyOn(globalThis, "fetch");
    const view = setup(read);
    await screen.findByRole("article", { name: "Pixel 9 Pro device" });
    saved = page([
      device({
        appVersion: "1.3.0",
        buildNumber: 50,
        location: { ...device().location!, country: "US", city: "New York" },
      }),
    ]);
    await act(() => view.publish());
    expect(screen.getByText("Version 1.3.0 · Build 50")).toBeInTheDocument();
    expect(
      field(screen.getByRole("article"), "Country / city"),
    ).toHaveTextContent("United States (US)");
    expect(screen.queryAllByText("Egypt (EG)")).toHaveLength(0);
    const calls = read.mock.calls.length;
    vi.useFakeTimers();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(read).toHaveBeenCalledTimes(calls);
    expect(fetch).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: /refresh|try again/i }),
    ).not.toBeInTheDocument();
  });

  it("paginates through the socket, resets on user navigation and ignores a late old-user snapshot", async () => {
    let finishOld: (value: AdminUserDevicePage) => void = () => {};
    const delayed = new Promise<AdminUserDevicePage>((resolve) => {
      finishOld = resolve;
    });
    const read = vi.fn((resource: string, params: Record<string, string>) => {
      expect(resource).toBe("admin.user_devices");
      if (params.id === "second-user")
        return page([
          device({
            deviceModel: "Second account Mac",
            installationId: "second-account",
            platform: "macos",
          }),
        ]);
      return params.before ? delayed : page([device()], "older-installations");
    });
    const view = setup(read);
    await screen.findByRole("article", { name: "Pixel 9 Pro device" });
    expect(
      screen.getByRole("button", { name: "Previous page" }),
    ).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(
      await screen.findByRole("status", { name: "Loading" }),
    ).toBeInTheDocument();
    expect(read).toHaveBeenCalledWith("admin.user_devices", {
      id: "first-user",
      before: "older-installations",
      limit: "20",
    });
    view.changeUser("second-user");
    await screen.findByRole("article", { name: "Second account Mac device" });
    expect(read).toHaveBeenCalledWith("admin.user_devices", {
      id: "second-user",
      limit: "20",
    });
    await act(async () => {
      finishOld(page([device({ deviceModel: "Late old account device" })]));
      await delayed;
    });
    expect(
      screen.queryByRole("article", { name: "Late old account device device" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Previous page" }),
    ).not.toBeInTheDocument();
  });

  it("returns to a previous device page using its cursor", async () => {
    const read = vi.fn(
      async (_resource: string, params: Record<string, string>) =>
        params.before
          ? page([
              device({
                deviceModel: "Older iPhone",
                installationId: "older-ios",
                platform: "ios",
              }),
            ])
          : page([device()], "older-installations"),
    );
    setup(read);
    await screen.findByRole("article", { name: "Pixel 9 Pro device" });
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByRole("article", { name: "Older iPhone device" });
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Previous page" }),
    );
    await screen.findByRole("article", { name: "Pixel 9 Pro device" });
    expect(
      screen.getByRole("button", { name: "Previous page" }),
    ).toBeDisabled();
  });

  it("labels cached observations when the live connection is unavailable", async () => {
    setup(async () => page([device()]));
    await screen.findByRole("article");
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(
      await screen.findByText(/last received device observations/),
    ).toBeInTheDocument();
    expect(screen.getByRole("article")).toBeInTheDocument();
    online.mockReturnValue(true);
  });

  it("shows an empty state and hides the section without users.read permission", async () => {
    const read = vi.fn().mockResolvedValue(page([]));
    const view = setup(read);
    expect(await screen.findByText("No recorded devices")).toBeInTheDocument();
    mocks.can.mockReturnValue(false);
    view.changeUser("second-user");
    expect(
      screen.queryByRole("region", { name: "Devices" }),
    ).not.toBeInTheDocument();
    expect(
      read.mock.calls.every(([, params]) => params.id === "first-user"),
    ).toBe(true);
    expect(mocks.can).toHaveBeenCalledWith("users.read");
  });

  it("does not subscribe when users.read is absent initially", async () => {
    mocks.can.mockReturnValue(false);
    const read = vi.fn();
    setup(read);
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      screen.queryByRole("region", { name: "Devices" }),
    ).not.toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
  });

  it("hides cached device details after a subscription permission error", async () => {
    let blocked = false;
    const error = new ApiError({
      status: 403,
      code: "FORBIDDEN",
      message: "Permission removed",
    });
    const view = setup(async () => {
      if (blocked) throw error;
      return page([device()]);
    });
    await screen.findByRole("article");
    blocked = true;
    await act(() => view.publish());
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /refresh|try again/i }),
    ).not.toBeInTheDocument();
  });

  it("maps its test adapter to the bounded compatibility endpoint", () => {
    expect(
      realtimeResourcePath("admin.user_devices", {
        id: "user/id",
        before: "opaque-cursor",
        limit: "20",
      }),
    ).toBe("/admin/users/user%2Fid/devices?before=opaque-cursor&limit=20");
  });

  it("provides an empty synthetic device page while preserving permission and missing-user errors", async () => {
    const fixture = createDashboardFixture();
    const request = {
      method: "GET",
      url: `/admin/users/${fixture.user.id}/devices?limit=20`,
      token: "owner-fixture",
    };
    expect(await fixture.handle(request)).toMatchObject({
      status: 200,
      body: { items: [], nextCursor: null, asOf: expect.any(String) },
    });
    expect(
      await fixture.handle({ ...request, token: "release_manager-fixture" }),
    ).toMatchObject({ status: 403 });
    fixture.userMissing = true;
    expect(await fixture.handle(request)).toMatchObject({ status: 404 });
  });
});
