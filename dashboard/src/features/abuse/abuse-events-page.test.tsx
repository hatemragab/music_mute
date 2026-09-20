import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import {
  AdminSessionProvider,
  type AuthAdapter,
  type AuthUser,
  useAdminSession,
} from "@/auth/admin-session";
import {
  createDashboardFixture,
  sessionForRole,
} from "@/test/dashboard-fixtures";
import { createDashboardHandlers } from "@/test/handlers";
import { dashboardServer } from "@/test/server";
import { AbuseEventsPage } from "./abuse-events-page";

const supportUser: AuthUser = {
  uid: "support-fixture",
  email: "support-fixture@example.invalid",
  getIdToken: vi.fn().mockResolvedValue("support-fixture"),
};

const adapter: AuthAdapter = {
  observe(listener) {
    listener(supportUser);
    return () => undefined;
  },
  signIn: vi.fn(),
  signOut: vi.fn(),
  reauthenticate: vi.fn(),
};

function Allowed({ children }: { children: React.ReactNode }) {
  return useAdminSession().state === "allowed" ? children : null;
}

describe("AbuseEventsPage", () => {
  it("renders bounded account events with accessible filters", async () => {
    const fixture = createDashboardFixture();
    fixture.abuseEvents.push({
      id: "000000000000000000000061",
      accountId: fixture.user.id,
      type: "upload_grant_limit",
      severity: "medium",
      operationClass: "upload_grant",
      count: 4,
      firstOccurredAt: "2026-09-11T00:00:00.000Z",
      lastOccurredAt: "2026-09-11T00:10:00.000Z",
      policyRevision: 2,
      restrictionId: null,
      restrictionStatus: "none",
    });
    dashboardServer.use(...createDashboardHandlers(fixture));
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <AdminSessionProvider
            queryClient={queryClient}
            adapter={adapter}
            getSession={vi.fn().mockResolvedValue(sessionForRole("support"))}
          >
            <Allowed>
              <AbuseEventsPage />
            </Allowed>
          </AdminSessionProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText("upload grant limit")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter account ID")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter event type")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter severity")).toBeInTheDocument();
    expect(screen.getByText("First occurrence")).toBeInTheDocument();
    expect(screen.getByText("Restriction")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: fixture.user.id })).toHaveAttribute(
      "href",
      `/users/${fixture.user.id}`,
    );
  });
});
