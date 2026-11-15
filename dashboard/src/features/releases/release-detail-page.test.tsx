import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardFixture, FIXTURE_IDS } from "@/test/dashboard-fixtures";
import { ReleaseDetailPage } from "./release-detail-page";

const mocks = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
vi.mock("@/auth/admin-session", () => ({
  useApiClient: () => ({}),
  useAdminSession: () => ({ can: () => true }),
}));
vi.mock("./releases-api", async (original) => ({
  ...(await original<typeof import("./releases-api")>()),
  getRelease: mocks.get,
  updateRelease: mocks.update,
}));

beforeEach(() => vi.clearAllMocks());
function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/releases/${FIXTURE_IDS.release}`]}>
        <Routes>
          <Route path="/releases/:id" element={<ReleaseDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
describe("release history", () => {
  it("reads a retired direct APK draft without edit, upload or policy actions", async () => {
    const historical = {
      ...new DashboardFixture().releases[0],
      source: "direct_apk",
      artifactState: "verified",
      bytes: 1024,
      sha256Hex: "a".repeat(64),
    };
    mocks.get.mockResolvedValue(historical);
    show();
    expect(
      await screen.findByRole("heading", { name: "2.0.0 (20)" }),
    ).toBeVisible();
    expect(screen.getAllByText(/Retired direct APK/)).toHaveLength(2);
    expect(screen.getByText("a".repeat(64))).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Edit draft" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Review policy" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("APK file")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /upload/i }),
    ).not.toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("lets a Play draft be reviewed and edited without any binary upload", async () => {
    mocks.get.mockResolvedValue(new DashboardFixture().releases[0]);
    show();
    expect(
      await screen.findByRole("button", { name: "Edit draft" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Review policy" })).toHaveAttribute(
      "href",
      `/update-policy?releaseId=${FIXTURE_IDS.release}`,
    );
    expect(
      screen.getByText("Not required for this distribution"),
    ).toBeVisible();
    expect(screen.queryByLabelText("APK file")).not.toBeInTheDocument();
  });
});
