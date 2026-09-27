import type { Page } from "@playwright/test";

import type { AdminRole } from "../../src/api/contracts";
import { fromWireCase, fromWireUrl, toWireCase } from "../../src/api/wire-case";
import {
  createDashboardFixture,
  type DashboardFixture,
} from "../../src/test/dashboard-fixtures";
import { E2E_API_ORIGIN, E2E_APP_ORIGIN } from "./urls";
import { realtimeResourcePath } from "../../src/test/realtime-resource-path";

const ROLE_KEY = "musicmute:e2e-role";

export async function setDashboardRole(page: Page, role: AdminRole | null) {
  await page.addInitScript(
    ({ key, value }) => {
      if (value) sessionStorage.setItem(key, value);
      else sessionStorage.removeItem(key);
    },
    { key: ROLE_KEY, value: role },
  );
}

export async function installDashboardFixture(
  page: Page,
  fixture: DashboardFixture = createDashboardFixture(),
) {
  let ticketToken: string | null = null;
  let ticketCount = 0;
  let connectionCount = 0;
  const publishers = new Set<() => Promise<void>>();
  await page.routeWebSocket(
    `${E2E_API_ORIGIN.replace(/^http/, "ws")}/realtime/socket`,
    (socket) => {
      connectionCount++;
      const token = ticketToken;
      const subscriptions = new Map<
        string,
        { resource: string; params: Record<string, string>; sequence: number }
      >();
      let closed = false;
      const publish = async () => {
        for (const [id, subscription] of subscriptions) {
          const response = await fixture.handle({
            method: "GET",
            url: `${E2E_API_ORIGIN}${realtimeResourcePath(subscription.resource, subscription.params)}`,
            token,
          });
          if (closed || subscriptions.get(id) !== subscription) continue;
          socket.send(
            JSON.stringify(
              response.status < 400
                ? {
                    type: "snapshot",
                    protocol_version: 1,
                    stream_id: "fixture",
                    subscription_id: id,
                    sequence: ++subscription.sequence,
                    data: toWireCase(response.body),
                  }
                : {
                    type: "subscription_error",
                    stream_id: "fixture",
                    subscription_id: id,
                    status: response.status,
                    code: "REQUEST_FAILED",
                  },
            ),
          );
        }
      };
      publishers.add(publish);
      socket.onClose(() => {
        closed = true;
        publishers.delete(publish);
      });
      socket.onMessage(async (raw) => {
        const command = JSON.parse(String(raw));
        if (command.type === "subscribe") {
          subscriptions.set(command.subscription_id, {
            resource: command.resource,
            params: command.params,
            sequence: 0,
          });
          await publish();
        }
        if (command.type === "resync") await publish();
        if (command.type === "unsubscribe")
          subscriptions.delete(command.subscription_id);
      });
      socket.send(
        JSON.stringify({
          type: "ready",
          protocol_version: 1,
          stream_id: "fixture",
        }),
      );
    },
  );
  await page.route(`${E2E_API_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const corsHeaders = {
      "access-control-allow-origin": E2E_APP_ORIGIN,
      "access-control-allow-headers":
        "Authorization, Content-Type, X-Request-Id, X-Installation-Id",
      "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    };
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: corsHeaders, body: "" });
      return;
    }
    const authorization = request.headers()["authorization"];
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : null;
    if (new URL(request.url()).pathname === "/admin/realtime-tickets") {
      ticketCount++;
      ticketToken = token;
      await route.fulfill({
        status: 201,
        headers: corsHeaders,
        body: JSON.stringify({
          ticket: "a".repeat(43),
          path: "/realtime/socket",
          protocol: "musicmute.realtime.v1",
          expires_at: "2099-01-01T00:00:00Z",
        }),
      });
      return;
    }
    let body: unknown;
    if (request.postData()) {
      try {
        body = request.postDataJSON();
      } catch {
        body = request.postData();
      }
    }
    const response = await fixture.handle({
      method: request.method(),
      url: fromWireUrl(request.url()),
      token,
      body: fromWireCase(body),
    });
    await route.fulfill({
      status: response.status,
      headers: { ...corsHeaders, ...response.headers },
      body:
        typeof response.body === "string"
          ? response.body
          : JSON.stringify(toWireCase(response.body)),
    });
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method()))
      await Promise.all([...publishers].map((publish) => publish()));
  });
  return Object.assign(fixture, {
    publishRealtime: () =>
      Promise.all([...publishers].map((publish) => publish())),
    realtimeTicketCount: () => ticketCount,
    realtimeConnectionCount: () => connectionCount,
  });
}
