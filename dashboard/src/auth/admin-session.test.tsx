import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AdminSession } from "@/api/contracts";
import {
  AdminSessionProvider,
  type AuthAdapter,
  type AuthUser,
  useAdminSession,
} from "./admin-session";

const owner: AdminSession = {
  uid: "owner-1",
  verifiedEmail: "owner@example.test",
  role: "owner",
  permissions: ["overview.read", "admin.access.manage"],
  accessRevision: 2,
  authTimeSec: 1_800_000_000,
  serverTime: "2026-09-11T00:00:00.000Z",
};

const user: AuthUser = {
  uid: "owner-1",
  email: "owner@example.test",
  getIdToken: vi.fn().mockResolvedValue("token"),
};

const Harness = () => {
  const session = useAdminSession();
  return (
    <div>
      <output>{session.state}</output>
      {session.session ? <span>Privileged {session.session.role}</span> : null}
      <button onClick={() => void session.reauthenticate()}>
        Reauthenticate
      </button>
      <button onClick={() => void session.signOut()}>Sign out</button>
    </div>
  );
};

const renderSession = (
  adapter: AuthAdapter,
  getSession: (signal?: AbortSignal) => Promise<AdminSession>,
) => {
  const queryClient = new QueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <AdminSessionProvider
        adapter={adapter}
        getSession={getSession}
        queryClient={queryClient}
      >
        <Harness />
      </AdminSessionProvider>
    </QueryClientProvider>,
  );
  return queryClient;
};

describe("AdminSessionProvider", () => {
  it("shows denied state without privileged content after backend rejection", async () => {
    const adapter: AuthAdapter = {
      observe: (listener) => {
        listener(user);
        return () => undefined;
      },
      signIn: vi.fn(),
      signOut: vi.fn(),
      reauthenticate: vi.fn(),
    };

    renderSession(adapter, vi.fn().mockRejectedValue({ status: 403 }));

    await waitFor(() => expect(screen.getByText("denied")).toBeVisible());
    expect(screen.queryByText(/Privileged/)).not.toBeInTheDocument();
  });

  it("clears privileged query data immediately when identity signs out", async () => {
    let authListener: (next: AuthUser | null) => void = () => undefined;
    const adapter: AuthAdapter = {
      observe: (listener) => {
        authListener = listener;
        listener(user);
        return () => undefined;
      },
      signIn: vi.fn(),
      signOut: vi.fn().mockImplementation(async () => authListener(null)),
      reauthenticate: vi.fn(),
    };
    const queryClient = renderSession(
      adapter,
      vi.fn().mockResolvedValue(owner),
    );
    queryClient.setQueryData(["private"], { secret: true });

    await screen.findByText("Privileged owner");
    await act(async () =>
      screen.getByRole("button", { name: "Sign out" }).click(),
    );

    await waitFor(() => expect(screen.getByText("signedOut")).toBeVisible());
    expect(queryClient.getQueryData(["private"])).toBeUndefined();
  });

  it("keeps an allowed page mounted while fresh authentication rechecks access", async () => {
    let resolveRefresh: (value: AdminSession) => void = () => undefined;
    const getSession = vi
      .fn<(signal?: AbortSignal) => Promise<AdminSession>>()
      .mockResolvedValueOnce(owner)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );
    const adapter: AuthAdapter = {
      observe: (listener) => {
        listener(user);
        return () => undefined;
      },
      signIn: vi.fn(),
      signOut: vi.fn(),
      reauthenticate: vi.fn(),
    };
    renderSession(adapter, getSession);
    await screen.findByText("Privileged owner");

    await act(async () => {
      screen.getByRole("button", { name: "Reauthenticate" }).click();
    });
    expect(screen.getByText("allowed")).toBeVisible();
    expect(screen.getByText("Privileged owner")).toBeVisible();

    resolveRefresh(owner);
    await waitFor(() => expect(getSession).toHaveBeenCalledTimes(2));
  });
});
