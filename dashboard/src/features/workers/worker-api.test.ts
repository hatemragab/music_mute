import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createElement, type ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "@/api/api-client";
import { toWireCase } from "@/api/wire-case";
import {
  AdminSessionProvider,
  type AuthAdapter,
  type AuthUser,
  useAdminSession,
} from "@/auth/admin-session";
import {
  createDashboardFixture,
  FIXTURE_IDS,
  sessionForRole,
} from "@/test/dashboard-fixtures";
import { createDashboardHandlers } from "@/test/handlers";
import { dashboardServer } from "@/test/server";
import {
  changeWorkerMachineState,
  createWorkerInvitation,
  getWorkerDiagnostics,
  listWorkerInvitations,
  listWorkerMachines,
  requestWorkerBenchmark,
  updateWorkerFleetPolicy,
} from "./worker-api";
import { WorkerFleetPage } from "./worker-fleet-page";
import { WorkerMachinePage } from "./worker-machine-page";

const client = () =>
  ({
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
  }) as unknown as ApiClient;

describe("worker dashboard API contracts", () => {
  it("encodes server-side fleet filters and cursors", async () => {
    const api = client();
    await listWorkerMachines(api, {
      status: "active",
      platform: "windows-amd64",
      groupId: "studio a",
      releaseVersion: "0.1.3",
      cursor: "cursor-value",
      limit: 25,
    });

    expect(api.get).toHaveBeenCalledWith(
      "/admin/worker-fleet/machines?status=active&platform=windows-amd64&groupId=studio+a&releaseVersion=0.1.3&cursor=cursor-value&limit=25",
    );
  });

  it("passes opaque cursors and page limits for invitations and machine diagnostics", async () => {
    const api = client();
    await listWorkerInvitations(api, { cursor: "next-invitation", limit: 25 });
    await getWorkerDiagnostics(api, "machine/unsafe", {
      cursor: "next-diagnostic",
      limit: 10,
    });

    expect(api.get).toHaveBeenNthCalledWith(
      1,
      "/admin/worker-fleet/invitations?cursor=next-invitation&limit=25",
    );
    expect(api.get).toHaveBeenNthCalledWith(
      2,
      "/admin/worker-fleet/machines/machine%2Funsafe/diagnostics?cursor=next-diagnostic&limit=10",
    );
  });

  it("uses the accepted enrollment, lifecycle and diagnostics routes", async () => {
    const api = client();
    const command = {
      operationId: "2bd185fb-d2d7-4c1e-82a8-63cfb6a7ed29",
      expectedRevision: 4,
      reason: "Synthetic contract fixture",
    };

    await createWorkerInvitation(api, {
      operationId: command.operationId,
      expiresInSeconds: 900,
      reason: command.reason,
    });
    await changeWorkerMachineState(api, "machine/unsafe", "drain", command);
    await getWorkerDiagnostics(api, "machine/unsafe");
    await requestWorkerBenchmark(api, "machine/unsafe", {
      ...command,
      recipeId: "kim-vocals-v2",
      iterations: 1,
    });

    expect(api.post).toHaveBeenNthCalledWith(
      1,
      "/admin/workers/invitations",
      expect.objectContaining({ expiresInSeconds: 900 }),
    );
    expect(api.post).toHaveBeenNthCalledWith(
      2,
      "/admin/workers/machines/machine%2Funsafe/drains",
      command,
    );
    expect(api.get).toHaveBeenCalledWith(
      "/admin/worker-fleet/machines/machine%2Funsafe/diagnostics",
    );
    expect(api.post).toHaveBeenNthCalledWith(
      3,
      "/admin/worker-fleet/machines/machine%2Funsafe/benchmark-runs",
      expect.objectContaining({ recipeId: "kim-vocals-v2" }),
    );
  });

  it("sends revision-fenced policy capacity", async () => {
    const api = client();
    const input = {
      operationId: "2bd185fb-d2d7-4c1e-82a8-63cfb6a7ed29",
      expectedRevision: 7,
      reason: "Adjust qualified capacity",
      acceptClaims: true,
      recipes: [
        {
          recipeId: "kim-vocals-v2",
          enabled: true,
          maxSlotsPerMachine: 1,
        },
      ],
      leaseSeconds: 60,
      processingDeadlineSeconds: 900,
      maxAttempts: 3,
    };
    await updateWorkerFleetPolicy(api, input);

    expect(api.put).toHaveBeenCalledWith("/admin/worker-fleet/policy", input);
  });
});

const authUser: AuthUser = {
  uid: "owner-fixture",
  email: "owner-fixture@example.invalid",
  getIdToken: vi.fn().mockResolvedValue("owner-fixture"),
};

const adapter: AuthAdapter = {
  observe(listener) {
    listener(authUser);
    return () => undefined;
  },
  signIn: vi.fn(),
  signOut: vi.fn(),
  reauthenticate: vi.fn(),
};

function Allowed({ children }: { children: ReactNode }) {
  return useAdminSession().state === "allowed" ? children : null;
}

function renderPage(page: ReactNode, initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    createElement(
      MemoryRouter,
      { initialEntries: [initialEntry] },
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AdminSessionProvider, {
          queryClient,
          adapter,
          getSession: vi.fn().mockResolvedValue(sessionForRole("owner")),
          children: createElement(Allowed, null, page),
        }),
      ),
    ),
  );
}

describe("worker dashboard pagination", () => {
  it("opens the next invitation page and resets to the first on tab selection", async () => {
    const fixture = createDashboardFixture();
    const first = fixture.workerInvitations[0]!;
    const second = { ...first, invitationId: "next-invitation-id" };
    const cursors: Array<string | null> = [];
    dashboardServer.use(...createDashboardHandlers(fixture));
    dashboardServer.use(
      http.get("*/admin/worker-fleet/invitations", ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("cursor");
        cursors.push(cursor);
        return HttpResponse.json(
          toWireCase({
            items: cursor ? [second] : [first],
            nextCursor: cursor ? null : "next-invitation",
            asOf: "2026-09-21T00:00:00.000Z",
          }) as Record<string, unknown>,
        );
      }),
    );
    const user = userEvent.setup();
    renderPage(createElement(WorkerFleetPage), "/workers");

    await user.click(await screen.findByRole("tab", { name: "Enrollment" }));
    expect(await screen.findByText(first.invitationId)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText(second.invitationId)).toBeInTheDocument();
    expect(cursors).toContain("next-invitation");

    await user.click(screen.getByRole("tab", { name: "Machines" }));
    await user.click(screen.getByRole("tab", { name: "Enrollment" }));
    expect(await screen.findByText(first.invitationId)).toBeInTheDocument();
  });

  it("opens the next page of machine diagnostics", async () => {
    const fixture = createDashboardFixture();
    const first = fixture.workerDiagnostics.items[0]!;
    const cursors: Array<string | null> = [];
    dashboardServer.use(...createDashboardHandlers(fixture));
    dashboardServer.use(
      http.get(
        `*/admin/worker-fleet/machines/${FIXTURE_IDS.workerMachine}/diagnostics`,
        ({ request }) => {
          const cursor = new URL(request.url).searchParams.get("cursor");
          cursors.push(cursor);
          return HttpResponse.json(
            toWireCase({
              items: cursor
                ? [
                    {
                      ...first,
                      id: "next-diagnostic-id",
                      lines: ["Second diagnostic page"],
                    },
                  ]
                : [first],
              nextCursor: cursor ? null : "next-diagnostic",
            }) as Record<string, unknown>,
          );
        },
      ),
    );
    const user = userEvent.setup();
    renderPage(
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: "/workers/:id",
          element: createElement(WorkerMachinePage),
        }),
      ),
      `/workers/${FIXTURE_IDS.workerMachine}`,
    );

    await user.click(await screen.findByRole("button", { name: "Next page" }));
    expect(
      await screen.findByText("Second diagnostic page"),
    ).toBeInTheDocument();
    expect(cursors).toContain("next-diagnostic");
  });
});
