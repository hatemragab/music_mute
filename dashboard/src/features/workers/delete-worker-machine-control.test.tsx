import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  OperationOutcomeUnknownError,
  type ApiClient,
} from "@/api/api-client";
import type { AdminRole } from "@/api/contracts";
import { ROLE_DETAILS } from "@/features/administrators/role-permissions";
import { createDashboardFixture } from "@/test/dashboard-fixtures";
import { DeleteWorkerMachineControl } from "./delete-worker-machine-control";
import { deleteWorkerMachine } from "./worker-api";

const mocks = vi.hoisted(() => ({
  role: "owner" as AdminRole,
  get: vi.fn(),
  post: vi.fn(),
  reauthenticate: vi.fn(),
  blocked: vi.fn(),
}));
vi.mock("@/auth/admin-session", () => ({
  useApiClient: () => ({ get: mocks.get, post: mocks.post }),
  useAdminSession: () => ({
    can: (permission: string) =>
      ROLE_DETAILS[mocks.role].permissions.includes(permission as never),
    reauthenticate: mocks.reauthenticate,
  }),
}));
const fixture = () => createDashboardFixture();
function setup(legacy = false) {
  const machine = {
    ...fixture().workerMachine,
    registeredByUserId: legacy ? null : fixture().user.id,
  };
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const view = render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <DeleteWorkerMachineControl
          machine={machine}
          disabled={false}
          onBlockedChange={mocks.blocked}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { user: userEvent.setup(), view, client, machine };
}
async function confirm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(
    screen.getByLabelText("Reason"),
    "Retire this worker and disable new registration",
  );
  await user.click(
    screen.getByRole("button", { name: "Reauthenticate with Google" }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Confirm deletion" }),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = "owner";
  mocks.get.mockResolvedValue({
    ...fixture().user,
    workerRegistrationAllowed: true,
  });
  mocks.post.mockImplementation(async (_path, input) => ({
    operationId: input.operationId,
    status: "succeeded",
    resourceId: fixture().workerMachine.machineId,
    revision: input.expectedRevision + 1,
  }));
  mocks.reauthenticate.mockResolvedValue(undefined);
});

describe("delete worker machine review", () => {
  it("captures machine and account revisions with fresh auth and a reason", async () => {
    const { user, machine } = setup();
    await user.click(screen.getByRole("button", { name: "Delete machine" }));
    await screen.findByText(/allowed and will be turned off/);
    expect(
      screen.getByRole("button", { name: "Reauthenticate with Google" }),
    ).toBeDisabled();
    await confirm(user);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledOnce());
    expect(mocks.post).toHaveBeenCalledWith(
      `/admin/workers/machines/${machine.machineId}/deletions`,
      expect.objectContaining({
        expectedRevision: machine.revision,
        registrationUserId: fixture().user.id,
        expectedUserRevision: fixture().user.revision,
        reason: "Retire this worker and disable new registration",
      }),
    );
    expect(mocks.reauthenticate).toHaveBeenCalledOnce();
  });
  it.each(["support", "viewer", "release_manager"] as const)(
    "hides deletion for %s",
    (role) => {
      mocks.role = role;
      setup();
      expect(
        screen.queryByRole("button", { name: "Delete machine" }),
      ).not.toBeInTheDocument();
    },
  );
  it("requires an explicit legacy search and existing account selection", async () => {
    mocks.get.mockImplementation(async (path: string) =>
      path.startsWith("/admin/users?")
        ? { items: [fixture().user], nextCursor: null }
        : { ...fixture().user, workerRegistrationAllowed: true },
    );
    const { user } = setup(true);
    await user.click(screen.getByRole("button", { name: "Delete machine" }));
    await user.type(screen.getByLabelText("Reason"), "Retire legacy machine");
    expect(
      screen.getByRole("button", { name: "Reauthenticate with Google" }),
    ).toBeDisabled();
    expect(mocks.get).not.toHaveBeenCalled();
    await user.type(
      screen.getByRole("textbox", { name: "Search registration account" }),
      fixture().user.email!,
    );
    expect(mocks.get).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Search accounts" }));
    await user.click(
      await screen.findByRole("button", {
        name: `Select ${fixture().user.email}`,
      }),
    );
    await screen.findByText(/allowed and will be turned off/);
    await user.click(
      screen.getByRole("button", { name: "Reauthenticate with Google" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Confirm deletion" }),
    );
    await waitFor(() => expect(mocks.post).toHaveBeenCalledOnce());
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });
  it("allows a missing known creator without a user revision", async () => {
    mocks.get.mockRejectedValue(
      new ApiError({ status: 404, code: "RESOURCE_NOT_FOUND" }),
    );
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Delete machine" }));
    await screen.findByText(/registered account no longer exists/);
    await confirm(user);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledOnce());
    expect(mocks.post.mock.calls[0]![1]).not.toHaveProperty(
      "expectedUserRevision",
    );
  });
  it("does not treat a missing legacy selection as a missing creator", async () => {
    mocks.get.mockImplementation(async (path: string) => {
      if (path.startsWith("/admin/users?"))
        return { items: [fixture().user], nextCursor: null };
      throw new ApiError({ status: 404, code: "RESOURCE_NOT_FOUND" });
    });
    const { user } = setup(true);
    await user.click(screen.getByRole("button", { name: "Delete machine" }));
    await user.type(screen.getByLabelText("Reason"), "Retire legacy machine");
    await user.type(
      screen.getByRole("textbox", { name: "Search registration account" }),
      fixture().user.email!,
    );
    await user.click(screen.getByRole("button", { name: "Search accounts" }));
    await user.click(
      await screen.findByRole("button", {
        name: `Select ${fixture().user.email}`,
      }),
    );
    await screen.findByRole("alert");
    expect(
      screen.getByRole("button", { name: "Reauthenticate with Google" }),
    ).toBeDisabled();
    expect(
      screen.queryByText(/registered account no longer exists/),
    ).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("blocks deletion when account inspection fails without assuming deletion", async () => {
    mocks.get.mockRejectedValue(
      new ApiError({ status: 403, code: "FORBIDDEN" }),
    );
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Delete machine" }));
    await screen.findByRole("alert");
    await user.type(screen.getByLabelText("Reason"), "Retire machine");
    expect(
      screen.getByRole("button", { name: "Reauthenticate with Google" }),
    ).toBeDisabled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("fences an unknown write and checks only the durable receipt", async () => {
    mocks.post.mockRejectedValue(new TypeError("lost response"));
    mocks.get.mockImplementation(async (path: string) => {
      if (path.startsWith("/admin/operations/"))
        throw new ApiError({ status: 503, code: "SERVICE_UNAVAILABLE" });
      return fixture().user;
    });
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Delete machine" }));
    await screen.findByText(/already off and will stay off/);
    await confirm(user);
    await screen.findByRole("button", { name: "Check deletion outcome" });
    expect(
      screen.getByRole("button", { name: "Delete machine" }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "Check deletion outcome" }),
    );
    await screen.findByText(/Further deletion requests remain blocked/);
    expect(mocks.post).toHaveBeenCalledOnce();
    const operationId = mocks.post.mock.calls[0]![1].operationId;
    mocks.get.mockResolvedValue({
      operationId,
      status: "succeeded",
      resourceId: fixture().workerMachine.machineId,
      revision: 5,
    });
    await user.click(
      screen.getByRole("button", { name: "Check deletion outcome" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Check deletion outcome" }),
      ).not.toBeInTheDocument(),
    );
    expect(mocks.post).toHaveBeenCalledOnce();
  });
  it("closes a conflicted review so current revisions must be reloaded", async () => {
    mocks.post.mockRejectedValue(
      new ApiError({ status: 409, code: "REVISION_CONFLICT" }),
    );
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Delete machine" }));
    await screen.findByText(/allowed and will be turned off/);
    await confirm(user);
    await screen.findByText(/machine or account changed/);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete machine" }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
  });
});

describe("machine deletion receipt contract", () => {
  const input = {
    operationId: "2bd185fb-d2d7-4c1e-82a8-63cfb6a7ed29",
    expectedRevision: 4,
    reason: "Retire worker",
  };
  it("uses the encoded route and accepts receipt-only success without resource reads", async () => {
    const api = {
      post: vi.fn().mockResolvedValue({
        ...input,
        status: "succeeded",
        resourceId: "machine/unsafe",
        revision: 5,
      }),
      get: vi.fn(),
    };
    await deleteWorkerMachine(
      api as unknown as ApiClient,
      "machine/unsafe",
      input,
    );
    expect(api.post).toHaveBeenCalledWith(
      "/admin/workers/machines/machine%2Funsafe/deletions",
      input,
    );
    expect(api.get).not.toHaveBeenCalled();
  });
  it.each([new SyntaxError("malformed response"), {}])(
    "blocks malformed successful responses",
    async (value) => {
      const api = {
        post:
          value instanceof Error
            ? vi.fn().mockRejectedValue(value)
            : vi.fn().mockResolvedValue(value),
        get: vi.fn(),
      };
      await expect(
        deleteWorkerMachine(api as unknown as ApiClient, "machine", input),
      ).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
      expect(api.post).toHaveBeenCalledOnce();
    },
  );
});
