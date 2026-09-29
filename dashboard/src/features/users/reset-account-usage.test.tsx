import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountUsage } from "@/api/contracts";
import { ProcessingUsageSection } from "./processing-usage-panel";
import { resetAccountUsage } from "./users-api";

const mocks = vi.hoisted(() => ({
  canManage: true,
  reauthenticate: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
}));
vi.mock("@/auth/admin-session", () => ({
  useApiClient: () => ({ get: mocks.get, post: mocks.post }),
  useAdminSession: () => ({
    can: (permission: string) =>
      permission !== "users.processing.manage" || mocks.canManage,
    reauthenticate: mocks.reauthenticate,
  }),
}));
const usage: AccountUsage = {
  schemaVersion: 2,
  plan: "standard",
  policyRevision: 2,
  overrideRevision: null,
  effectivePolicySource: "global",
  overrideExpiresAt: null,
  period: {
    key: "2026-09",
    start: "2026-09-01T00:00:00.000Z",
    end: "2026-10-01T00:00:00.000Z",
    nextResetAt: "2026-10-01T00:00:00.000Z",
  },
  processing: {
    limitSeconds: 7_200,
    usedSeconds: 900,
    reservedSeconds: 600,
    releasedSeconds: 300,
    remainingSeconds: 5_700,
  },
  uploads: {
    dailyGrantLimit: 30,
    dailyGrants: 2,
    dailyRemainingGrants: 28,
    dailyResetAt: "2026-09-14T00:00:00.000Z",
    monthlyGrantLimit: 200,
    monthlyGrants: 12,
    monthlyRemainingGrants: 188,
    monthlyByteLimit: 1_000_000_000,
    confirmedBytes: 50_000_000,
    monthlyRemainingBytes: 950_000_000,
    monthlyResetAt: "2026-10-01T00:00:00.000Z",
  },
  storage: {
    limitBytes: 1_000_000_000,
    retainedBytes: 100_000_000,
    remainingBytes: 900_000_000,
  },
  effectiveLimits: {
    maxDurationSeconds: 1_200,
    maxPreparedAudioBytes: 50_000_000,
    maxClientInputAttempts: 5,
    signedUrlTtlSeconds: 600,
  },
  downloads: {
    monthlyGrantLimit: 150,
    monthlyGrants: 10,
    monthlyRemainingGrants: 140,
    monthlyByteLimit: 10_000_000_000,
    estimatedBytes: 500_000_000,
    monthlyRemainingBytes: 9_500_000_000,
    monthlyResetAt: "2026-10-01T00:00:00.000Z",
  },
  usageRevision: 4,
  waitingJobs: 3,
  maxWaitingJobs: 3,
  processingJobs: 1,
  maxProcessingJobs: 1,
  availability: { status: "blocked", reason: "waiting_job_limit" },
  checkedAt: "2026-09-13T12:00:00Z",
  policyOverride: null,
};
const updated: AccountUsage = {
  ...usage,
  usageRevision: 5,
  processing: {
    ...usage.processing,
    usedSeconds: 0,
    releasedSeconds: 0,
    reservedSeconds: 0,
  },
};
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ProcessingUsageSection userId="fixture-user" />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.canManage = true;
  mocks.get.mockResolvedValue(usage);
  mocks.post.mockResolvedValue(updated);
  mocks.reauthenticate.mockResolvedValue(undefined);
});
describe("account usage reset", () => {
  it("requires a reason and reauthentication, submits the displayed revision and updates usage", async () => {
    const user = setup();
    await user.click(
      await screen.findByRole("button", { name: "Reset usage" }),
    );
    expect(
      screen.getByText(/actual storage usage stay unchanged/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reauthenticate with Google" }),
    ).toBeDisabled();
    await user.type(screen.getByLabelText("Reason"), "Restore allowance");
    await user.click(
      screen.getByRole("button", { name: "Reauthenticate with Google" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Reset usage to zero" }),
    );
    await waitFor(() => expect(mocks.post).toHaveBeenCalledOnce());
    expect(mocks.post).toHaveBeenCalledWith(
      "/admin/users/fixture-user/account-usage-resets",
      expect.objectContaining({
        reason: "Restore allowance",
        expectedRevision: 4,
        periodKey: "2026-09",
        dayKey: "2026-09-13",
        operationId: expect.any(String),
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getAllByText("0 min").length).toBeGreaterThan(0);
  });
  it("hides the action without processing permission", async () => {
    mocks.canManage = false;
    setup();
    await screen.findByText(/Usage belongs to the account/);
    expect(
      screen.queryByRole("button", { name: "Reset usage" }),
    ).not.toBeInTheDocument();
  });
  it("recovers a lost response through the receipt without replaying the reset", async () => {
    const client = {
      post: vi.fn().mockRejectedValue(new TypeError("Network failure")),
      get: vi
        .fn()
        .mockResolvedValueOnce({ status: "succeeded" })
        .mockResolvedValueOnce(updated),
    };
    const result = await resetAccountUsage(client as never, "fixture-user", {
      expectedRevision: 4,
      periodKey: "2026-09",
      dayKey: "2026-09-13",
      operationId: "fixture-operation",
      reason: "Restore allowance",
    });
    expect(result).toEqual(updated);
    expect(client.post).toHaveBeenCalledOnce();
    expect(client.get).toHaveBeenCalledWith(
      "/admin/operations/fixture-operation",
    );
  });
});
