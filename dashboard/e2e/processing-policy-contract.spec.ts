import { expect, test } from "@playwright/test";
import { E2E_API_ROOT, setDashboardRole } from "./helpers/session";

test("compiled backend accepts basic processing settings", async ({ page }) => {
  await setDashboardRole(page, "owner");
  await page.goto("/overview");
  const result = await page.evaluate(async (root) => {
    const request = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(root + path, {
        method,
        headers: {
          authorization: "Bearer owner-fixture",
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return {
        status: response.status,
        value: await response.json().catch(() => null),
      };
    };
    const before = await request("GET", "/admin/settings/processing");
    const command = {
      acceptNewJobs: false,
      maintenanceMessageEn: "Processing redesign in progress",
      maintenanceMessageAr: null,
      maxInputBytesExclusive: before.value.maxInputBytesExclusive,
      maxDurationSecondsExclusive: before.value.maxDurationSecondsExclusive,
      maxActiveJobsPerUser: before.value.maxActiveJobsPerUser,
      expectedRevision: before.value.revision,
      operationId: crypto.randomUUID(),
      reason: "Validate the basic settings contract",
    };
    const save = await request("PUT", "/admin/settings/processing", command);
    const after = await request("GET", "/admin/settings/processing");
    const conflict = await request("PUT", "/admin/settings/processing", {
      ...command,
      operationId: crypto.randomUUID(),
    });
    const allowance = await request(
      "PUT",
      "/admin/users/missing-user/processing-allowance",
      {
        expectedRevision: 0,
        operationId: crypto.randomUUID(),
        reason: "Check valid allowance DTO for absent fixture user",
        allowanceAudioSeconds: 7200,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
    );
    return {
      before,
      save,
      after,
      conflict,
      allowance,
    };
  }, E2E_API_ROOT);
  expect(result.before.status).toBe(200);
  expect(result.save.status).toBe(200);
  expect(result.after.value.revision).toBe(result.before.value.revision + 1);
  expect(result.after.value.acceptNewJobs).toBe(false);
  expect(result.conflict.status).toBe(409);
  expect(result.allowance.status).toBe(404);
});
