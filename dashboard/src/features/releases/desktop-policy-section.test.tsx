import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/api-client";
import { DesktopPolicySection } from "./desktop-policy-section";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  save: vi.fn(),
  reauthenticate: vi.fn(),
  manage: true,
}));
vi.mock("@/auth/admin-session", () => ({
  useApiClient: () => ({}),
  useAdminSession: () => ({
    can: () => mocks.manage,
    reauthenticate: mocks.reauthenticate,
  }),
}));
vi.mock("./desktop-policy-api", () => ({
  getDesktopUpdatePolicy: mocks.read,
  updateDesktopPolicy: mocks.save,
}));
const policy = {
  revision: 3,
  macos: { minimumBuild: 11 },
  windows: { minimumBuild: 12 },
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.manage = true;
  mocks.read.mockResolvedValue(policy);
  mocks.reauthenticate.mockResolvedValue(undefined);
  mocks.save.mockImplementation(async (_client, input) => ({
    policy: { ...policy, revision: 4, ...input.platforms },
    appliedRevision: 4,
  }));
});
function show() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <DesktopPolicySection />
    </QueryClientProvider>,
  );
}
async function confirm() {
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "Review desktop gates" }),
  );
  const dialog = within(screen.getByRole("dialog"));
  await user.type(
    dialog.getByLabelText("Reason"),
    "Reviewed desktop compatibility",
  );
  await user.click(
    dialog.getByRole("button", { name: "Reauthenticate with Google" }),
  );
  await user.click(
    await dialog.findByRole("button", { name: "Save desktop gates" }),
  );
}
describe("desktop build gates", () => {
  it("freezes reviewed Windows-only changes and requires fresh Google authentication", async () => {
    const user = userEvent.setup();
    show();
    const windows = await screen.findByLabelText("Windows minimum build");
    await user.clear(windows);
    await user.type(windows, "42");
    await user.click(
      screen.getByRole("button", { name: "Review desktop gates" }),
    );
    expect(windows).toBeDisabled();
    expect(screen.getByLabelText("macOS minimum build")).toBeDisabled();
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("Windows: 42")).toBeVisible();
    expect(mocks.save).not.toHaveBeenCalled();
    await user.type(
      dialog.getByLabelText("Reason"),
      "Reviewed desktop compatibility",
    );
    await user.click(
      dialog.getByRole("button", { name: "Reauthenticate with Google" }),
    );
    await user.click(
      await dialog.findByRole("button", { name: "Save desktop gates" }),
    );
    await waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    expect(mocks.save).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        expectedRevision: 3,
        platforms: { windows: { minimumBuild: 42 } },
        reason: "Reviewed desktop compatibility",
        operationId: expect.any(String),
      }),
    );
    expect(mocks.reauthenticate).toHaveBeenCalledOnce();
    expect(mocks.read).toHaveBeenCalledOnce();
  });
  it("clears an explicitly blank gate while preserving the other channel", async () => {
    const user = userEvent.setup();
    show();
    await user.clear(await screen.findByLabelText("Windows minimum build"));
    await confirm();
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          platforms: { windows: { minimumBuild: null } },
        }),
      ),
    );
    expect(screen.getByLabelText("macOS minimum build")).toHaveValue(11);
  });
  it("disables writes without releases.manage", async () => {
    mocks.manage = false;
    show();
    expect(
      await screen.findByLabelText("Windows minimum build"),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Review desktop gates" }),
    ).toBeDisabled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("rejects fractional or out-of-range minimums before review", async () => {
    const user = userEvent.setup();
    show();
    const windows = await screen.findByLabelText("Windows minimum build");
    await user.clear(windows);
    await user.type(windows, "1.5");
    expect(screen.getByRole("alert")).toHaveTextContent("whole build number");
    expect(
      screen.getByRole("button", { name: "Review desktop gates" }),
    ).toBeDisabled();
    await user.clear(windows);
    await user.type(windows, "2147483648");
    expect(
      screen.getByRole("button", { name: "Review desktop gates" }),
    ).toBeDisabled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("reads current state once after a revision conflict and requires a new review", async () => {
    mocks.read.mockResolvedValueOnce(policy).mockResolvedValue({
      ...policy,
      revision: 5,
      windows: { minimumBuild: 50 },
    });
    mocks.save.mockRejectedValue(
      new ApiError({
        status: 409,
        code: "REVISION_CONFLICT",
        message: "Policy changed",
      }),
    );
    const user = userEvent.setup();
    show();
    await user.clear(await screen.findByLabelText("Windows minimum build"));
    await user.type(screen.getByLabelText("Windows minimum build"), "42");
    await confirm();
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Windows minimum build")).toHaveValue(50);
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "Review desktop gates" }),
    ).toBeDisabled();
  });
  it("renders read failures without editable guessed defaults", async () => {
    mocks.read.mockRejectedValue(new Error("Desktop policy unavailable"));
    show();
    await screen.findByText("Desktop policy unavailable");
    expect(
      screen.queryByLabelText("Windows minimum build"),
    ).not.toBeInTheDocument();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
