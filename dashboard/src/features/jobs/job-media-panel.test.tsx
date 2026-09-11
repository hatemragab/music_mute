import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { JobMediaPanel } from "./job-media-panel";

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

describe("JobMediaPanel", () => {
  it("requests a short-lived media grant only after the explicit reviewed action", async () => {
    const fixture = createDashboardFixture();
    dashboardServer.use(...createDashboardHandlers(fixture));
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <AdminSessionProvider
          queryClient={queryClient}
          adapter={adapter}
          getSession={vi.fn().mockResolvedValue(sessionForRole("support"))}
        >
          <Allowed>
            <JobMediaPanel job={fixture.job} />
          </Allowed>
        </AdminSessionProvider>
      </QueryClientProvider>,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Play input" }));
    expect(
      fixture.requests.filter(({ url }) => url.includes("media-grants")),
    ).toHaveLength(0);

    await user.type(screen.getByLabelText("Reason"), "Investigate user report");
    await user.click(
      screen.getByRole("button", { name: /Reauthenticate and review/i }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Confirm play" }),
    );

    await waitFor(() =>
      expect(
        fixture.requests.filter(({ url }) => url.includes("media-grants")),
      ).toHaveLength(1),
    );
    expect(
      fixture.requests.find(({ url }) => url.includes("media-grants"))?.body,
    ).toMatchObject({
      asset: "input",
      purpose: "play",
      reason: "Investigate user report",
    });
    expect(
      fixture.requests.find(({ url }) => url.includes("media-grants"))?.body,
    ).not.toHaveProperty("action");
    expect(
      screen.getByLabelText(`input audio for job ${fixture.job.id}`),
    ).toHaveAttribute("preload", "none");
  });
});
