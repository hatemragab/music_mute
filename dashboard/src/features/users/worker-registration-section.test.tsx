import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/api-client";
import type { AdminRole, UserDetail } from "@/api/contracts";
import { ROLE_DETAILS } from "@/features/administrators/role-permissions";
import { createDashboardFixture } from "@/test/dashboard-fixtures";
import { WorkerRegistrationSection } from "./worker-registration-section";
import { setWorkerRegistration } from "./users-api";

const mocks = vi.hoisted(() => ({
  role: "owner" as AdminRole,
  get: vi.fn(),
  put: vi.fn(),
  reauthenticate: vi.fn(),
  updated: vi.fn(),
}));
vi.mock("@/auth/admin-session", () => ({
  useApiClient: () => ({ get: mocks.get, put: mocks.put }),
  useAdminSession: () => ({
    can: (permission: string) =>
      ROLE_DETAILS[mocks.role].permissions.includes(permission as never),
    reauthenticate: mocks.reauthenticate,
  }),
}));

const label = "Allow this account to register worker machines";
const initial = () => createDashboardFixture().user;

function setup(data: UserDetail = initial()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Section() {
    const [saved, setSaved] = useState(data);
    return (
      <WorkerRegistrationSection
        data={saved}
        onUpdated={async (updated) => {
          mocks.updated(updated);
          setSaved(updated);
        }}
      />
    );
  }
  render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <Section />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return userEvent.setup();
}

async function reviewAndSave(user: ReturnType<typeof userEvent.setup>) {
  const savedSwitch = screen.getByRole("switch", { name: label });
  await user.click(savedSwitch);
  expect(savedSwitch).not.toBeChecked();
  expect(
    screen.getByRole("button", { name: "Reauthenticate with Google" }),
  ).toBeDisabled();
  await user.type(screen.getByLabelText("Reason"), "Approve this Mac account");
  await user.click(
    screen.getByRole("button", { name: "Reauthenticate with Google" }),
  );
  await user.click(
    await screen.findByRole("button", { name: "Save registration permission" }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = "owner";
  mocks.get.mockResolvedValue({
    ...initial(),
    workerRegistrationAllowed: true,
    revision: 2,
  });
  mocks.put.mockResolvedValue({ status: "succeeded" });
  mocks.reauthenticate.mockResolvedValue(undefined);
});

describe("worker registration permission", () => {
  it.each(["owner", "support"] as const)(
    "%s saves approval with a reason, fresh authentication and the displayed revision",
    async (role) => {
      mocks.role = role;
      const data = { ...initial(), providers: ["password"] };
      const user = setup(data);
      expect(screen.getByRole("switch", { name: label })).not.toBeChecked();
      expect(
        screen.getByText(/Turning this off prevents new registrations/),
      ).toBeInTheDocument();
      await reviewAndSave(user);
      await waitFor(() =>
        expect(screen.getByRole("switch", { name: label })).toBeChecked(),
      );
      expect(mocks.reauthenticate).toHaveBeenCalledOnce();
      expect(mocks.put).toHaveBeenCalledWith(
        `/admin/users/${data.id}/worker-registration`,
        {
          workerRegistrationAllowed: true,
          expectedRevision: 1,
          operationId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          ),
          reason: "Approve this Mac account",
        },
      );
      expect(mocks.get).toHaveBeenCalledWith(`/admin/users/${data.id}`);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    },
  );

  it.each(["viewer", "release_manager"] as const)(
    "%s cannot change the saved value",
    (role) => {
      mocks.role = role;
      setup({ ...initial(), workerRegistrationAllowed: true });
      expect(screen.getByRole("switch", { name: label })).toBeChecked();
      expect(screen.getByRole("switch", { name: label })).toBeDisabled();
      expect(screen.getByText(/cannot change it/)).toBeInTheDocument();
      expect(mocks.put).not.toHaveBeenCalled();
    },
  );

  it.each(["disabled", "deleting", "purging"])(
    "shows the saved permission but cannot modify a %s account",
    (status) => {
      setup({ ...initial(), status, workerRegistrationAllowed: true });
      expect(screen.getByRole("switch", { name: label })).toBeChecked();
      expect(screen.getByRole("switch", { name: label })).toBeDisabled();
      expect(
        screen.getByText(/existing machines are unaffected/),
      ).toBeInTheDocument();
    },
  );

  it("cancelling review preserves the saved permission", async () => {
    const user = setup();
    await user.click(screen.getByRole("switch", { name: label }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("switch", { name: label })).not.toBeChecked();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("reads committed approval after a lost response without replaying the write", async () => {
    mocks.put.mockRejectedValueOnce(new TypeError("Network failure"));
    mocks.get
      .mockResolvedValueOnce({ status: "succeeded" })
      .mockResolvedValueOnce({
        ...initial(),
        workerRegistrationAllowed: true,
        revision: 2,
      });
    const user = setup();
    await reviewAndSave(user);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: label })).toBeChecked(),
    );
    expect(mocks.put).toHaveBeenCalledOnce();
    expect(mocks.get.mock.calls[0]?.[0]).toMatch(/^\/admin\/operations\//);
  });

  it("blocks more writes until an unresolved operation can be checked", async () => {
    mocks.put.mockRejectedValueOnce(new TypeError("Network failure"));
    mocks.get.mockRejectedValueOnce(new TypeError("Receipt unavailable"));
    const user = setup();
    await reviewAndSave(user);
    const check = await screen.findByRole("button", {
      name: "Check operation outcome",
    });
    expect(screen.getByRole("switch", { name: label })).toBeDisabled();
    mocks.get.mockResolvedValueOnce({ status: "pending" });
    await user.click(check);
    expect(
      await screen.findByText(/operation is still pending/),
    ).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: label })).toBeDisabled();
    mocks.get
      .mockResolvedValueOnce({ status: "succeeded" })
      .mockResolvedValueOnce({
        ...initial(),
        workerRegistrationAllowed: true,
        revision: 2,
      });
    await user.click(check);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: label })).toBeEnabled(),
    );
    expect(screen.getByRole("switch", { name: label })).toBeChecked();
    expect(mocks.put).toHaveBeenCalledOnce();
  });

  it("reads current account state after a stale revision and requires a new review", async () => {
    mocks.put.mockRejectedValueOnce(
      new ApiError({
        status: 409,
        code: "REVISION_CONFLICT",
        message: "Account changed",
      }),
    );
    const user = setup();
    await reviewAndSave(user);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: label })).toBeChecked(),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText(/Review its saved value/)).toBeInTheDocument();
    expect(mocks.put).toHaveBeenCalledOnce();
  });

  it.each([
    new ApiError({ status: 401 }),
    new ApiError({ status: 403 }),
    new ApiError({ status: 404 }),
    new ApiError({ status: 429 }),
    new SyntaxError("Invalid read-back JSON"),
    new TypeError("Network failure"),
  ])(
    "fences a committed write after read-back fails with %s",
    async (error) => {
      mocks.get.mockRejectedValueOnce(error);
      const user = setup();
      await reviewAndSave(user);
      const check = await screen.findByRole("button", {
        name: "Check operation outcome",
      });
      expect(screen.getByRole("switch", { name: label })).toBeDisabled();
      expect(mocks.put).toHaveBeenCalledOnce();
      mocks.get
        .mockResolvedValueOnce({ status: "succeeded" })
        .mockResolvedValueOnce({
          ...initial(),
          workerRegistrationAllowed: true,
          revision: 2,
        });
      await user.click(check);
      await waitFor(() =>
        expect(screen.getByRole("switch", { name: label })).toBeEnabled(),
      );
      expect(screen.getByRole("switch", { name: label })).toBeChecked();
      expect(mocks.put).toHaveBeenCalledOnce();
      expect(mocks.get).toHaveBeenNthCalledWith(
        1,
        `/admin/users/${initial().id}`,
      );
      expect(mocks.get.mock.calls[1]?.[0]).toMatch(/^\/admin\/operations\//);
      expect(mocks.get).toHaveBeenNthCalledWith(
        3,
        `/admin/users/${initial().id}`,
      );
    },
  );

  it("fences a successful write whose response cannot be decoded", async () => {
    mocks.put.mockRejectedValueOnce(new SyntaxError("Invalid mutation JSON"));
    const user = setup();
    await reviewAndSave(user);
    const check = await screen.findByRole("button", {
      name: "Check operation outcome",
    });
    expect(screen.getByRole("switch", { name: label })).toBeDisabled();
    mocks.get
      .mockResolvedValueOnce({ status: "succeeded" })
      .mockResolvedValueOnce({
        ...initial(),
        workerRegistrationAllowed: true,
        revision: 2,
      });
    await user.click(check);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: label })).toBeEnabled(),
    );
    expect(mocks.put).toHaveBeenCalledOnce();
  });

  it("wraps the committed resource read failure with its operation ID", async () => {
    const api = {
      put: vi.fn().mockResolvedValue({ status: "succeeded" }),
      get: vi.fn().mockRejectedValueOnce(new TypeError("Read-back failed")),
    };
    await expect(
      setWorkerRegistration(api as never, "account", {
        workerRegistrationAllowed: true,
        expectedRevision: 1,
        operationId: "fixture-operation",
        reason: "Approve registration",
      }),
    ).rejects.toMatchObject({ operationId: "fixture-operation" });
    expect(api.put).toHaveBeenCalledOnce();
  });
});
