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
  getWorkerDiagnostics,
  listWorkerMachines,
  requestWorkerBenchmark,
  updateWorkerFleetPolicy,
} from "./worker-api";
import { WorkerFleetPage } from "./worker-fleet-page";
import { WorkerMachinePage } from "./worker-machine-page";
import { RealtimeTestProvider } from "@/test/realtime-test-provider";

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

  it("passes opaque cursors and page limits for machine diagnostics", async () => {
    const api = client();
    await getWorkerDiagnostics(api, "machine/unsafe", {
      cursor: "next-diagnostic",
      limit: 10,
    });
    expect(api.get).toHaveBeenCalledWith(
      "/admin/worker-fleet/machines/machine%2Funsafe/diagnostics?cursor=next-diagnostic&limit=10",
    );
  });

  it("uses the accepted lifecycle and diagnostics routes", async () => {
    const api = client();
    const command = {
      operationId: "2bd185fb-d2d7-4c1e-82a8-63cfb6a7ed29",
      expectedRevision: 4,
      reason: "Synthetic contract fixture",
    };

    await changeWorkerMachineState(api, "machine/unsafe", "drain", command);
    await getWorkerDiagnostics(api, "machine/unsafe");
    await requestWorkerBenchmark(api, "machine/unsafe", {
      ...command,
      recipeId: "kim-vocals-v2",
      iterations: 1,
    });

    expect(api.post).toHaveBeenNthCalledWith(
      1,
      "/admin/workers/machines/machine%2Funsafe/drains",
      command,
    );
    expect(api.get).toHaveBeenCalledWith(
      "/admin/worker-fleet/machines/machine%2Funsafe/diagnostics",
    );
    expect(api.post).toHaveBeenNthCalledWith(
      2,
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
  return useAdminSession().state === "allowed"
    ? createElement(RealtimeTestProvider, { children })
    : null;
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
  it("keeps machine controls independent of the registering account", async () => {
    const fixture = createDashboardFixture();
    fixture.user.status = "deleting";
    fixture.user.workerRegistrationAllowed = false;
    fixture.workerMachine.registeredByUserId = fixture.user.id;
    dashboardServer.use(...createDashboardHandlers(fixture));
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
    expect(
      await screen.findByText("Registered through account"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: fixture.user.id })).toHaveAttribute(
      "href",
      `/users/${fixture.user.id}`,
    );
    expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Revoke" })).toBeEnabled();
    expect(
      fixture.requests.some(({ url }) => url.includes("worker-registration")),
    ).toBe(false);
  });

  it("manages registered machines without invitation UI or reads", async () => {
    const fixture = createDashboardFixture();
    dashboardServer.use(...createDashboardHandlers(fixture));
    const user = userEvent.setup();
    renderPage(createElement(WorkerFleetPage), "/workers");

    expect(
      await screen.findByRole("tab", { name: "Machines" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("link", { name: /Windows Z440/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: "Enrollment" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /Create invitation|Create replacement/,
      }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Policy" }));
    expect(await screen.findByText("Claim policy")).toBeInTheDocument();
    expect(
      fixture.requests.some(({ url }) => url.includes("invitations")),
    ).toBe(false);
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

describe("worker capacity approval", () => {
  it("requires a reason and fresh sign-in before posting the selected GPU and revision", async () => {
    const fixture = createDashboardFixture();
    const submissions: unknown[] = [];
    dashboardServer.use(...createDashboardHandlers(fixture));
    dashboardServer.use(
      http.post(
        `*/admin/worker-fleet/machines/${FIXTURE_IDS.workerMachine}/capacity-approvals`,
        async ({ request }) => {
          submissions.push(await request.json());
          return HttpResponse.json({
            machine_id: FIXTURE_IDS.workerMachine,
            revision: 2,
            max_slots: 2,
            replayed: false,
          });
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
    await user.click(
      await screen.findByRole("button", { name: "Approve two workers" }),
    );
    expect(
      screen.getByRole("button", { name: "Reauthenticate with Google" }),
    ).toBeDisabled();
    await user.type(
      screen.getByLabelText("Reason"),
      "Reviewed installed native qualification report",
    );
    await user.click(
      screen.getByRole("button", { name: "Reauthenticate with Google" }),
    );
    const dialog = screen.getByRole("dialog");
    const { within } = await import("@testing-library/react");
    await user.click(
      await within(dialog).findByRole("button", {
        name: "Approve two workers",
      }),
    );
    expect(submissions).toEqual([
      expect.objectContaining({
        gpu_id: "0",
        qualification_confirmed: true,
        expected_revision: fixture.workerMachine.revision,
        reason: "Reviewed installed native qualification report",
      }),
    ]);
  });
});
