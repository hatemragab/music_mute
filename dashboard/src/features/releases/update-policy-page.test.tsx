import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardFixture, FIXTURE_IDS } from "@/test/dashboard-fixtures";
import type { PolicyPreviewResult } from "./policy-preview";
import { UpdatePolicyPage } from "./update-policy-page";

const mocks = vi.hoisted(() => ({
  policy: vi.fn(),
  releases: vi.fn(),
  preview: vi.fn(),
  publish: vi.fn(),
  withdraw: vi.fn(),
  reauthenticate: vi.fn(),
  desktop: vi.fn(),
}));
vi.mock("@/auth/admin-session", () => ({
  useApiClient: () => ({}),
  useAdminSession: () => ({
    can: () => true,
    reauthenticate: mocks.reauthenticate,
  }),
}));
vi.mock("./releases-api", async (original) => ({
  ...(await original<typeof import("./releases-api")>()),
  getUpdatePolicy: mocks.policy,
  listReleases: mocks.releases,
  previewUpdatePolicy: mocks.preview,
  publishRelease: mocks.publish,
  withdrawRelease: mocks.withdraw,
}));
vi.mock("./desktop-policy-api", () => ({
  getDesktopUpdatePolicy: mocks.desktop,
  updateDesktopPolicy: vi.fn(),
}));

const validPreview: PolicyPreviewResult = {
  currentRevision: 1,
  valid: true,
  errors: [],
  examples: [
    {
      platform: "android",
      distribution: "play",
      installedBuild: 9,
      decision: "required",
      targetBuild: 20,
    },
  ],
};
let fixture: DashboardFixture;
beforeEach(() => {
  vi.clearAllMocks();
  fixture = new DashboardFixture();
  mocks.policy.mockResolvedValue(fixture.policy);
  mocks.releases.mockResolvedValue({
    items: fixture.releases,
    nextCursor: null,
  });
  mocks.preview.mockResolvedValue(validPreview);
  mocks.publish.mockResolvedValue({});
  mocks.reauthenticate.mockResolvedValue(undefined);
  mocks.desktop.mockResolvedValue({
    revision: 1,
    macos: { minimumBuild: null },
    windows: { minimumBuild: null },
  });
});
function show(id = FIXTURE_IDS.release) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/update-policy?releaseId=${id}`]}>
        <UpdatePolicyPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Google Play update policy", () => {
  it("publishes without an artifact after preview, audience confirmation and fresh auth", async () => {
    const user = userEvent.setup();
    show();
    const publish = await screen.findByRole("button", {
      name: "Publish release",
    });
    expect(await screen.findByLabelText("Windows minimum build")).toBeVisible();
    expect(fixture.releases[0].artifactState).toBeNull();
    expect(publish).toBeDisabled();
    expect(
      screen.queryByLabelText("Distribution source"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Direct release ID"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        /Builds below this version code must update from Google Play/,
      ),
    ).toBeVisible();
    await user.clear(screen.getByLabelText("Play release ID"));
    await user.type(
      screen.getByLabelText("Play release ID"),
      FIXTURE_IDS.release,
    );
    await user.click(screen.getByRole("button", { name: "Preview policy" }));
    await screen.findByText("Policy is valid");
    expect(publish).toBeDisabled();
    await user.click(
      screen.getByRole("checkbox", {
        name: /I verified that this store release/,
      }),
    );
    expect(publish).toBeEnabled();
    await user.click(publish);
    const dialog = within(screen.getByRole("dialog"));
    await user.type(dialog.getByLabelText("Reason"), "Play audience verified");
    await user.click(
      dialog.getByRole("button", { name: "Reauthenticate with Google" }),
    );
    await user.click(
      await dialog.findByRole("button", { name: "Publish release" }),
    );
    expect(mocks.reauthenticate).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledWith(
      {},
      FIXTURE_IDS.release,
      expect.objectContaining({
        policy: expect.objectContaining({
          android: expect.objectContaining({
            source: "google_play",
            directReleaseId: null,
          }),
        }),
        storeAvailabilityConfirmed: true,
        reason: "Play audience verified",
        expectedRevision: 1,
        expectedReleaseRevision: 1,
      }),
    );
  });

  it("invalidates a preview when the minimum changes and ignores an in-flight old result", async () => {
    const user = userEvent.setup();
    let resolve: (value: PolicyPreviewResult) => void = () => undefined;
    mocks.preview.mockImplementation(
      () =>
        new Promise<PolicyPreviewResult>((done) => {
          resolve = done;
        }),
    );
    show();
    await screen.findByLabelText("Play release ID");
    await user.click(screen.getByRole("button", { name: "Preview policy" }));
    await waitFor(() => expect(mocks.preview).toHaveBeenCalledOnce());
    const minimum = screen.getAllByLabelText("Minimum supported build")[0];
    await user.clear(minimum);
    await user.type(minimum, "12");
    await act(async () => resolve(validPreview));
    expect(screen.queryByText("Policy is valid")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Publish release" }),
    ).toBeDisabled();
    mocks.preview.mockResolvedValue(validPreview);
    await user.click(screen.getByRole("button", { name: "Preview policy" }));
    await screen.findByText("Policy is valid");
    await user.clear(minimum);
    await user.type(minimum, "13");
    expect(screen.queryByText("Policy is valid")).not.toBeInTheDocument();
  });

  it("keeps historical direct releases out of target selection and exposes no mutation action", async () => {
    fixture.releases[0].source = "direct_apk";
    fixture.releases[0].artifactState = "verified";
    const user = userEvent.setup();
    show();
    await screen.findByText(/Retired direct APK. This release is read-only/);
    expect(
      screen.queryByRole("button", { name: "Publish release" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Withdraw with replacement" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", {
        name: /I verified that this store release/,
      }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Select release" }));
    expect(
      screen.queryByRole("option", { name: /2.0.0/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /1.0.0/ })).toBeVisible();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.withdraw).not.toHaveBeenCalled();
  });
});
