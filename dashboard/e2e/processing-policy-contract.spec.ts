import { expect, test } from "@playwright/test";
import { setDashboardRole } from "./helpers/session";
import { E2E_API_ORIGIN } from "./helpers/urls";

test("compiled backend accepts the standard account policy", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  await page.goto("/overview");
  const result = await page.evaluate(async (root) => {
    const wireCase = <T>(value: T, fromWire = false): T => {
      if (Array.isArray(value))
        return value.map((item) => wireCase(item, fromWire)) as T;
      if (value === null || typeof value !== "object") return value;
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          fromWire
            ? key.replace(
                /_([a-z0-9])/g,
                (match, letter: string, offset: number) =>
                  offset === 0 ? match : letter.toUpperCase(),
              )
            : key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
          wireCase(item, fromWire),
        ]),
      ) as T;
    };
    const request = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(root + path, {
        method,
        headers: {
          authorization: "Bearer owner-fixture",
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(wireCase(body)),
      });
      return {
        status: response.status,
        value: wireCase(await response.json().catch(() => null), true),
      };
    };
    const before = await request("GET", "/admin/settings/account-policy");
    const command = {
      acceptNewJobs: false,
      maintenanceMessageEn: "Processing redesign in progress",
      maintenanceMessageAr: null,
      ...before.value.values,
      expectedRevision: before.value.revision,
      operationId: crypto.randomUUID(),
      reason: "Validate the standard account policy contract",
    };
    const save = await request(
      "PUT",
      "/admin/settings/account-policy",
      command,
    );
    const after = await request("GET", "/admin/settings/account-policy");
    const conflict = await request("PUT", "/admin/settings/account-policy", {
      ...command,
      operationId: crypto.randomUUID(),
    });
    const override = await request(
      "PUT",
      "/admin/users/68c000000000000000000099/account-policy-override",
      {
        expectedRevision: 0,
        operationId: crypto.randomUUID(),
        reason: "Check a valid override DTO for an absent fixture user",
        values: { monthlyProcessingSeconds: 7200 },
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
    );
    return {
      before,
      save,
      after,
      conflict,
      override,
    };
  }, E2E_API_ORIGIN);
  expect(result.before.status).toBe(200);
  expect(result.save.status).toBe(200);
  expect(result.after.value.revision).toBe(result.before.value.revision + 1);
  expect(result.after.value.acceptNewJobs).toBe(false);
  expect(result.conflict.status).toBe(409);
  expect(result.override.status).toBe(404);
});
