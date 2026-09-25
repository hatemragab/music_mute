import type { Page } from "@playwright/test";

import type { AdminRole } from "../../src/api/contracts";
import { fromWireCase, fromWireUrl, toWireCase } from "../../src/api/wire-case";
import {
  createDashboardFixture,
  type DashboardFixture,
} from "../../src/test/dashboard-fixtures";
import { E2E_API_ORIGIN, E2E_APP_ORIGIN } from "./urls";

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
  });
  return fixture;
}
