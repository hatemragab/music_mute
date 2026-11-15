import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardFixture, FIXTURE_IDS } from "@/test/dashboard-fixtures";
import { ProcessingSettingsPage } from "./processing-settings-page";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
  can: vi.fn(),
  reauthenticate: vi.fn(),
  searchUsers: vi.fn(),
  getUser: vi.fn(),
}));
vi.mock("@/auth/admin-session", () => ({
  useApiClient: () => ({}),
  useAdminSession: () => ({
    can: mocks.can,
    reauthenticate: mocks.reauthenticate,
  }),
}));
vi.mock("./settings-api", () => ({
  getAccountPolicy: mocks.get,
  updateAccountPolicy: mocks.save,
}));
vi.mock("@/features/users/users-api", () => ({
  listUsers: mocks.searchUsers,
  getUser: mocks.getUser,
}));
vi.mock("@/components/unsaved-changes-guard", () => ({
  UnsavedChangesGuard: () => null,
}));

beforeEach(() => {
  vi.clearAllMocks();
  const policy = new DashboardFixture().settings;
  mocks.get.mockResolvedValue(policy);
  mocks.save.mockImplementation(async (_client, command) => ({
    ...policy,
    ...command,
    revision: 2,
  }));
  mocks.can.mockReturnValue(true);
  mocks.reauthenticate.mockResolvedValue(undefined);
  mocks.searchUsers.mockResolvedValue({
    items: [new DashboardFixture().user],
    nextCursor: null,
  });
  mocks.getUser.mockResolvedValue(new DashboardFixture().user);
});
function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ProcessingSettingsPage />
    </QueryClientProvider>,
  );
}
describe("native link import settings", () => {
  it("finds an exact account ID with the detail endpoint and canonicalizes uppercase input", async () => {
    const id = "abcd1234abcd1234abcd1234";
    mocks.getUser.mockResolvedValue({ ...new DashboardFixture().user, id });
    const user = userEvent.setup();
    show();
    await screen.findByRole("switch", { name: "Show import from link" });
    fireEvent.change(
      screen.getByLabelText("Hide link import for these users"),
      { target: { value: id.toUpperCase() } },
    );
    await user.click(screen.getByRole("button", { name: "Search users" }));
    await user.click(
      await screen.findByRole("checkbox", { name: /Fixture Listener/ }),
    );
    expect(mocks.getUser).toHaveBeenCalledWith({}, id);
    expect(mocks.searchUsers).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: new RegExp(`Remove user.*${id}`) }),
    ).toBeInTheDocument();
  });

  it("lets read-only viewers page through more than twenty selections with bounded identity reads", async () => {
    const ids = Array.from({ length: 21 }, (_, index) =>
      (index + 1).toString(16).padStart(24, "0"),
    );
    mocks.can.mockImplementation(
      (permission) =>
        permission === "settings.read" || permission === "users.read",
    );
    mocks.get.mockResolvedValue({
      ...new DashboardFixture().settings,
      linkImportDisabledUserIds: ids,
    });
    mocks.getUser.mockImplementation(async (_client, id) => ({
      ...new DashboardFixture().user,
      id,
      displayName: `Account ${id}`,
      email: null,
    }));
    const user = userEvent.setup();
    show();
    const next = await screen.findByRole("button", {
      name: "Next selected users",
    });
    expect(next).toBeEnabled();
    await waitFor(() => expect(mocks.getUser).toHaveBeenCalledTimes(20));
    await user.click(next);
    expect(
      await screen.findByRole("button", {
        name: new RegExp(`Remove user Account ${ids[20]}`),
      }),
    ).toBeDisabled();
    expect(mocks.getUser).toHaveBeenCalledTimes(21);
    expect(screen.getByRole("button", { name: "Search users" })).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "Previous selected users" }),
    );
    expect(mocks.getUser).toHaveBeenCalledTimes(21);
    expect(mocks.searchUsers).not.toHaveBeenCalled();
  });

  it("keeps selections across explicit user-search pages", async () => {
    const first = new DashboardFixture().user;
    const second = {
      ...first,
      id: "abcd1234abcd1234abcd1234",
      displayName: "Another Listener",
    };
    mocks.searchUsers
      .mockResolvedValueOnce({ items: [first], nextCursor: "next-users" })
      .mockResolvedValueOnce({ items: [second], nextCursor: null });
    const user = userEvent.setup();
    show();
    await screen.findByRole("switch", { name: "Show import from link" });
    await user.click(screen.getByRole("button", { name: "Search users" }));
    await user.click(
      await screen.findByRole("checkbox", { name: /Fixture Listener/ }),
    );
    await user.click(screen.getByRole("button", { name: "Next page" }));
    await user.click(
      await screen.findByRole("checkbox", { name: /Another Listener/ }),
    );
    expect(screen.getByText("Selected: 2")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Remove user Fixture Listener/ }),
    ).toBeInTheDocument();
    expect(mocks.searchUsers).toHaveBeenLastCalledWith(
      {},
      { query: undefined, cursor: "next-users" },
    );
  });

  it("selects, reviews and saves users, then restores country rules when removed", async () => {
    let policy = {
      ...new DashboardFixture().settings,
      linkImportEnabled: true,
    };
    mocks.get.mockImplementation(async () => policy);
    mocks.save.mockImplementation(async (_client, command) => {
      policy = { ...policy, ...command, revision: policy.revision + 1 };
      return policy;
    });
    const user = userEvent.setup();
    const view = show();
    await screen.findByRole("switch", { name: "Show import from link" });
    const search = screen.getByLabelText("Hide link import for these users");
    fireEvent.change(search, { target: { value: "listener" } });
    expect(mocks.searchUsers).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Search users" }));
    await user.click(
      await screen.findByRole("checkbox", { name: /Fixture Listener/ }),
    );
    fireEvent.change(search, { target: { value: "nobody" } });
    mocks.searchUsers.mockResolvedValueOnce({ items: [], nextCursor: null });
    await user.click(screen.getByRole("button", { name: "Search users" }));
    expect(
      await screen.findByText("No users match this search."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Remove user Fixture Listener/ }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review changes" }));
    let dialog = within(screen.getByRole("dialog"));
    expect(
      dialog.getByText(new RegExp(`Hidden users: none → ${FIXTURE_IDS.user}`)),
    ).toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText("Reason"), {
      target: { value: "Hide this selected account" },
    });
    await user.click(
      dialog.getByRole("button", { name: "Reauthenticate with Google" }),
    );
    await user.click(
      await dialog.findByRole("button", { name: "Save policy" }),
    );
    expect(mocks.save).toHaveBeenLastCalledWith(
      {},
      expect.objectContaining({
        linkImportDisabledUserIds: [FIXTURE_IDS.user],
        linkImportEnabled: true,
        expectedRevision: 1,
        operationId: expect.any(String),
        reason: "Hide this selected account",
      }),
    );
    view.unmount();
    show();
    await user.click(
      await screen.findByRole("button", {
        name: /Remove user Fixture Listener/,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Review changes" }));
    dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText("Reason"), {
      target: { value: "Restore standard visibility" },
    });
    await user.click(
      dialog.getByRole("button", { name: "Reauthenticate with Google" }),
    );
    await user.click(
      await dialog.findByRole("button", { name: "Save policy" }),
    );
    expect(mocks.save).toHaveBeenLastCalledWith(
      {},
      expect.objectContaining({
        linkImportDisabledUserIds: [],
        linkImportEnabled: true,
        expectedRevision: 2,
      }),
    );
    expect(mocks.reauthenticate).toHaveBeenCalledTimes(2);
  });

  it("retains selected users after search and identity failures, including deleted accounts", async () => {
    mocks.get.mockResolvedValue({
      ...new DashboardFixture().settings,
      linkImportDisabledUserIds: [FIXTURE_IDS.user],
    });
    mocks.getUser.mockRejectedValue(new Error("Account no longer exists"));
    mocks.searchUsers.mockRejectedValue(new Error("Directory unavailable"));
    const user = userEvent.setup();
    show();
    await screen.findByText(/Account details are unavailable/);
    await user.type(
      screen.getByLabelText("Hide link import for these users"),
      "listener",
    );
    await user.click(screen.getByRole("button", { name: "Search users" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "User search failed",
    );
    await user.click(
      screen.getByRole("button", {
        name: `Remove user ${FIXTURE_IDS.user} (${FIXTURE_IDS.user})`,
      }),
    );
    expect(screen.getByText("Selected: 0")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Review changes" }),
    ).toBeEnabled();
  });

  it("shows read-only selected users without directory permission or lookup requests", async () => {
    mocks.can.mockImplementation(
      (permission) => permission === "settings.read",
    );
    mocks.get.mockResolvedValue({
      ...new DashboardFixture().settings,
      linkImportDisabledUserIds: [FIXTURE_IDS.user],
    });
    show();
    expect(
      await screen.findByRole("button", {
        name: `Remove user ${FIXTURE_IDS.user} (${FIXTURE_IDS.user})`,
      }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Search users" }),
    ).not.toBeInTheDocument();
    expect(mocks.searchUsers).not.toHaveBeenCalled();
    expect(mocks.getUser).not.toHaveBeenCalled();
  });

  it("allows settings managers to remove unavailable IDs without users.read, but cannot add users", async () => {
    mocks.can.mockImplementation(
      (permission) =>
        permission === "settings.read" || permission === "settings.manage",
    );
    mocks.get.mockResolvedValue({
      ...new DashboardFixture().settings,
      linkImportDisabledUserIds: [FIXTURE_IDS.user],
    });
    const user = userEvent.setup();
    show();
    await user.click(
      await screen.findByRole("button", {
        name: `Remove user ${FIXTURE_IDS.user} (${FIXTURE_IDS.user})`,
      }),
    );
    expect(screen.getByText("Selected: 0")).toBeInTheDocument();
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Search users" }),
    ).not.toBeInTheDocument();
  });

  it("saves visibility and sorted countries with revision, reason and fresh auth", async () => {
    const user = userEvent.setup();
    show();
    const toggle = await screen.findByRole("switch", {
      name: "Show import from link",
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(toggle);
    const search = screen.getByLabelText("Hide link import in these countries");
    await user.type(search, "US");
    await user.click(
      screen.getByRole("checkbox", { name: "United States (US)" }),
    );
    await user.clear(search);
    await user.type(search, "Egypt");
    await user.click(screen.getByRole("checkbox", { name: "Egypt (EG)" }));
    expect(
      screen.getByRole("button", { name: "Remove Egypt (EG)" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review changes" }));
    const dialog = within(screen.getByRole("dialog"));
    await user.type(
      dialog.getByLabelText("Reason"),
      "Native visibility rollout",
    );
    await user.click(
      dialog.getByRole("button", { name: "Reauthenticate with Google" }),
    );
    await user.click(
      await dialog.findByRole("button", { name: "Save policy" }),
    );
    expect(mocks.reauthenticate).toHaveBeenCalledOnce();
    expect(mocks.save).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        linkImportEnabled: true,
        linkImportDisabledCountries: ["EG", "US"],
        expectedRevision: 1,
        reason: "Native visibility rollout",
        operationId: expect.any(String),
      }),
    );
  });
  it("keeps the picker visible while hidden and allows removing country chips", async () => {
    mocks.get.mockResolvedValue({
      ...new DashboardFixture().settings,
      linkImportDisabledCountries: ["EG"],
      linkImportForcedOff: true,
    });
    const user = userEvent.setup();
    show();
    await screen.findByRole("switch", { name: "Show import from link" });
    expect(
      screen.getByText(/API process flag keeps native link import hidden/),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Hide link import in these countries"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove Egypt (EG)" }));
    expect(
      screen.getByRole("checkbox", { name: "Egypt (EG)" }),
    ).toHaveAttribute("aria-checked", "false");
  });
  it("allows settings.read without exposing a save action", async () => {
    mocks.can.mockImplementation(
      (permission) => permission === "settings.read",
    );
    show();
    expect(
      await screen.findByRole("switch", { name: "Show import from link" }),
    ).toBeDisabled();
    expect(
      screen.getByLabelText("Hide link import in these countries"),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Review changes" }),
    ).not.toBeInTheDocument();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
