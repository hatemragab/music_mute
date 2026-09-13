import { expect, test } from "@playwright/test";
import { setDashboardRole } from "./helpers/session";

test("compiled backend accepts v2 policy command and reports unqualified capacity", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  await page.goto("/overview");
  const result = await page.evaluate(async () => {
    const root = "http://127.0.0.1:3100/api/v1";
    const request = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(root + path, {
        method,
        headers: {
          authorization: "Bearer owner-fixture",
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, value: await response.json() };
    };
    const before = await request("GET", "/admin/settings/processing-v2");
    const command = {
      ...before.value,
      expectedRevision: before.value.revision,
      operationId: crypto.randomUUID(),
      reason: "Validate exact dashboard v2 contract in isolated backend",
    };
    delete command.revision;
    delete command.updatedAt;
    delete command.readiness;
    delete command.shortLongThresholdSeconds;
    const save = await request("PUT", "/admin/settings/processing-v2", command);
    const after = await request("GET", "/admin/settings/processing-v2");
    const conflict = await request("PUT", "/admin/settings/processing-v2", {
      ...command,
      operationId: crypto.randomUUID(),
    });
    const queue = await request("GET", "/admin/jobs/queue-summary");
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
    return { before, save, after, conflict, queue, allowance };
  });
  expect(result.before.status).toBe(200);
  expect(result.save.status).toBe(200);
  expect(result.after.value.revision).toBe(result.before.value.revision + 1);
  expect(result.after.value.qualification).toBeNull();
  expect(result.after.value.readiness.expandedAdmissionAvailable).toBe(false);
  expect(result.conflict.status).toBe(409);
  expect(result.queue.status).toBe(200);
  expect(result.queue.value.estimatedWaitRange).toBeNull();
  expect(result.queue.value.shortLongThresholdSeconds).toBe(600);
  expect(result.queue.value.distribution.short.jobs).toBeGreaterThanOrEqual(0);
  expect(result.allowance.status).toBe(404);
});
