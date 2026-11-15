import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AdminSession } from "@/api/contracts";
import {
  AdminSessionProvider,
  type AuthAdapter,
  type AuthUser,
  useAdminSession,
} from "@/auth/admin-session";
import { createWorkerInvitation } from "./worker-api";
import { WorkerEnrollmentDialog } from "./worker-enrollment-dialog";

vi.mock("./worker-api", () => ({
  createWorkerInvitation: vi.fn(),
}));

const owner: AdminSession = {
  uid: "owner-1",
  verifiedEmail: "owner@example.test",
  role: "owner",
  permissions: ["workers.read", "workers.enroll"],
  accessRevision: 2,
  authTimeSec: 1_800_000_000,
  serverTime: "2026-09-20T00:00:00.000Z",
};

const authUser: AuthUser = {
  uid: owner.uid,
  email: owner.verifiedEmail,
  getIdToken: vi.fn().mockResolvedValue("token"),
};

function Harness() {
  const { state } = useAdminSession();
  return state === "allowed" ? (
    <WorkerEnrollmentDialog onCreated={vi.fn()} />
  ) : null;
}

describe("WorkerEnrollmentDialog", () => {
  it("keeps the one-use credential local and clears it when closed", async () => {
    const adapter: AuthAdapter = {
      observe(listener) {
        listener(authUser);
        return () => undefined;
      },
      signIn: vi.fn(),
      signOut: vi.fn(),
      reauthenticate: vi.fn(),
    };
    vi.mocked(createWorkerInvitation).mockResolvedValue({
      invitationId: "7a155328-7d4f-4102-a99f-63ea3025935f",
      revision: 0,
      credential: "one-use-secret",
      expiresAt: "2026-09-20T00:15:00.000Z",
      replayed: false,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <AdminSessionProvider
          queryClient={queryClient}
          adapter={adapter}
          getSession={vi.fn().mockResolvedValue(owner)}
        >
          <Harness />
        </AdminSessionProvider>
      </QueryClientProvider>,
    );

    const trigger = await screen.findByRole("button", {
      name: "Create invitation",
    });
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.type(
      screen.getByLabelText("Reason"),
      "Enroll the Windows worker",
    );
    await user.click(screen.getByRole("button", { name: "Verify identity" }));
    await waitFor(() => expect(adapter.reauthenticate).toHaveBeenCalledOnce());
    await user.click(
      await screen.findByRole("button", { name: "Create one-use code" }),
    );

    expect(await screen.findByText("one-use-secret")).toBeVisible();
    expect(queryClient.getQueryCache().findAll()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "I saved the code" }));
    expect(screen.queryByText("one-use-secret")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());

    await user.click(screen.getByRole("button", { name: "Create invitation" }));
    expect(screen.queryByText("one-use-secret")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Reason")).toHaveValue("");
  });
});
