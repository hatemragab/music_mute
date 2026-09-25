import { expect, test } from "@playwright/test";

import { setDashboardRole } from "./helpers/session";
import { E2E_API_ORIGIN } from "./helpers/urls";

test("browser enforces session, permission, receipt, concurrency, and revision contracts through compiled Nest", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  await page.goto("/overview");
  await expect(
    page.getByRole("heading", { name: "Operations overview" }),
  ).toBeVisible();

  const result = await page.evaluate(async (api) => {
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
    const request = async (
      method: string,
      path: string,
      token: string,
      body?: unknown,
    ) => {
      const response = await fetch(`${api}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(wireCase(body)),
      });
      const text = await response.text();
      return {
        status: response.status,
        cacheControl: response.headers.get("cache-control"),
        value: text ? wireCase(JSON.parse(text), true) : null,
      };
    };

    const ownerSession = await request(
      "GET",
      "/admin/session",
      "owner-fixture",
    );
    const forbidden = await request(
      "POST",
      "/admin/access",
      "support-fixture",
      {
        verifiedEmail: "forged-browser@example.invalid",
        role: "owner",
        reason: "Attempt privilege escalation from browser",
        operationId: crypto.randomUUID(),
      },
    );

    const operationId = crypto.randomUUID();
    const concurrentBody = {
      verifiedEmail: "browser-concurrency@example.invalid",
      role: "viewer",
      reason: "Verify browser operation id concurrency",
      operationId,
    };
    const concurrent = await Promise.all([
      request("POST", "/admin/access", "owner-fixture", concurrentBody),
      request("POST", "/admin/access", "owner-fixture", concurrentBody),
    ]);
    const receipt = await request(
      "GET",
      `/admin/operations/${operationId}`,
      "owner-fixture",
    );
    const accesses = await request(
      "GET",
      "/admin/access?limit=100",
      "owner-fixture",
    );
    const support = accesses.value.items.find(
      (item: { uid: string }) => item.uid === "support-fixture",
    );
    const created = accesses.value.items.filter(
      (item: { verifiedEmail: string }) =>
        item.verifiedEmail === "browser-concurrency@example.invalid",
    );

    const revoked = await request(
      "PATCH",
      "/admin/access/support-fixture",
      "owner-fixture",
      {
        active: false,
        expectedRevision: support.revision,
        reason: "Verify immediate browser session revocation",
        operationId: crypto.randomUUID(),
      },
    );
    const stale = await request(
      "PATCH",
      "/admin/access/support-fixture",
      "owner-fixture",
      {
        active: true,
        expectedRevision: support.revision,
        reason: "Verify stale browser revision rejection",
        operationId: crypto.randomUUID(),
      },
    );
    const supportSession = await request(
      "GET",
      "/admin/session",
      "support-fixture",
    );

    return {
      ownerSession,
      forbidden,
      concurrentStatuses: concurrent.map(({ status }) => status).sort(),
      receipt,
      createdCount: created.length,
      revoked,
      stale,
      supportSession,
    };
  }, E2E_API_ORIGIN);

  expect(result.ownerSession.status).toBe(200);
  expect(result.ownerSession.cacheControl).toBe("no-store");
  expect(result.ownerSession.value.role).toBe("owner");
  expect(result.forbidden.status).toBe(403);
  expect(result.concurrentStatuses[0]).toBe(201);
  expect([201, 409]).toContain(result.concurrentStatuses[1]);
  expect(result.receipt.status).toBe(200);
  expect(result.receipt.value.status).toBe("succeeded");
  expect(result.createdCount).toBe(1);
  expect(result.revoked.status).toBe(200);
  expect(result.stale.status).toBe(409);
  expect(result.stale.value.code).toBe("REVISION_CONFLICT");
  expect(result.supportSession.status).toBe(403);
});

test("dashboard media and release payloads pass compiled backend validation", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  await page.goto("/overview");

  const result = await page.evaluate(async (api) => {
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
      const response = await fetch(`${api}${path}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: "Bearer owner-fixture",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(wireCase(body)) : undefined,
      });
      return {
        status: response.status,
        value: wireCase(await response.json().catch(() => null), true),
      };
    };
    const missingId = "000000000000000000000099";
    const media = await request(
      "POST",
      `/admin/jobs/${missingId}/media-grants`,
      {
        asset: "result",
        purpose: "play",
        operationId: crypto.randomUUID(),
        reason: "Validate the dashboard media contract",
      },
    );
    const edit = await request("PATCH", `/admin/releases/${missingId}`, {
      versionName: "2.0.0",
      buildNumber: 20,
      changelogEn: "Validate release editing",
      storeUrl: null,
      expectedRevision: 1,
      operationId: crypto.randomUUID(),
      reason: "Validate the dashboard release contract",
    });
    const current = await request("GET", "/admin/update-policy");
    const selection = {
      android: current.value.android,
      ios: current.value.ios,
    };
    const preview = await request(
      "POST",
      "/admin/update-policy/previews",
      selection,
    );
    const publish = await request(
      "POST",
      `/admin/releases/${missingId}/publications`,
      {
        expectedRevision: current.value.revision,
        expectedReleaseRevision: 1,
        policy: selection,
        operationId: crypto.randomUUID(),
        reason: "Validate the dashboard publish contract",
        storeAvailabilityConfirmed: false,
      },
    );
    const withdraw = await request(
      "POST",
      `/admin/releases/${missingId}/withdrawals`,
      {
        expectedRevision: current.value.revision,
        expectedReleaseRevision: 1,
        replacementPolicy: selection,
        operationId: crypto.randomUUID(),
        reason: "Validate the dashboard withdrawal contract",
      },
    );
    return { media, edit, current, preview, publish, withdraw };
  }, E2E_API_ORIGIN);

  expect(result.current.status).toBe(200);
  expect(result.preview.status).toBe(201);
  for (const response of [
    result.media,
    result.edit,
    result.publish,
    result.withdraw,
  ]) {
    expect(response.status).not.toBe(400);
  }
});

test("every dashboard mutation payload passes compiled backend strict validation", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  await page.goto("/overview");

  const responses = await page.evaluate(async (api) => {
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
    const missingId = "000000000000000000000098";
    const request = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${api}${path}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: "Bearer owner-fixture",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(wireCase(body)),
      });
      return {
        status: response.status,
        code:
          wireCase(await response.json().catch(() => null), true)?.code ?? null,
      };
    };
    const revision = () => ({
      expectedRevision: 0,
      operationId: crypto.randomUUID(),
      reason: "Validate the dashboard request contract",
    });
    const results: Record<string, { status: number; code: string | null }> = {};

    results.accountRestrictionPut = await request(
      "PUT",
      "/admin/users/missing-user/restriction",
      {
        expectedRevision: 0,
        operationId: crypto.randomUUID(),
        reasonCode: "manual_review",
        note: "Validate the account restriction contract",
      },
    );
    results.accountRestrictionDelete = await request(
      "DELETE",
      "/admin/users/missing-user/restriction",
      {
        expectedRevision: 1,
        operationId: crypto.randomUUID(),
        reason: "Validate the account restriction removal contract",
      },
    );
    results.jobCancel = await request(
      "POST",
      `/admin/jobs/${missingId}/cancellations`,
      revision(),
    );
    results.alertAcknowledge = await request(
      "POST",
      `/admin/alerts/${missingId}/acknowledgements`,
      revision(),
    );

    const settings = await request("GET", "/admin/settings/account-policy");
    const settingsResponse = await fetch(
      `${api}/admin/settings/account-policy`,
      {
        headers: {
          accept: "application/json",
          authorization: "Bearer owner-fixture",
        },
      },
    );
    const currentSettings = wireCase(await settingsResponse.json(), true);
    results.settingsRead = settings;
    results.settingsUpdate = await request(
      "PUT",
      "/admin/settings/account-policy",
      {
        acceptNewJobs: currentSettings.acceptNewJobs,
        maintenanceMessageEn: currentSettings.maintenanceMessageEn,
        maintenanceMessageAr: currentSettings.maintenanceMessageAr,
        ...currentSettings.values,
        expectedRevision: currentSettings.revision,
        operationId: crypto.randomUUID(),
        reason: "Validate the standard account policy contract",
      },
    );

    const releaseProposalResponse = await fetch(
      `${api}/admin/releases/proposal?platform=android&source=direct_apk`,
      {
        headers: {
          accept: "application/json",
          authorization: "Bearer owner-fixture",
        },
      },
    );
    const releaseProposal = wireCase(
      await releaseProposalResponse.json(),
      true,
    );
    results.releaseCreate = await request("POST", "/admin/releases", {
      platform: "android",
      source: "direct_apk",
      versionName: releaseProposal.suggested.versionName,
      buildNumber: releaseProposal.suggested.buildNumber,
      changelogEn: "Validate release creation contract",
      storeUrl: null,
      operationId: crypto.randomUUID(),
      reason: "Validate release creation contract",
    });
    results.releaseUploadReserve = await request(
      "POST",
      `/admin/releases/${missingId}/uploads`,
      {
        bytes: 1024,
        sha256Hex: "a".repeat(64),
        expectedRevision: 0,
        operationId: crypto.randomUUID(),
      },
    );
    results.releaseUploadComplete = await request(
      "POST",
      `/admin/releases/${missingId}/uploads/${missingId}/completions`,
      { operationId: crypto.randomUUID() },
    );

    return results;
  }, E2E_API_ORIGIN);

  for (const [route, response] of Object.entries(responses)) {
    expect(response.status, `${route}: ${response.code}`).not.toBe(400);
    expect(response.status, `${route}: ${response.code}`).toBeLessThan(500);
  }
});
