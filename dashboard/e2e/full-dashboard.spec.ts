import { expect, test } from "@playwright/test";

import {
  createDashboardFixture,
  FIXTURE_IDS,
} from "../src/test/dashboard-fixtures";
import { fromWireCase, toWireCase } from "../src/api/wire-case";
import { installDashboardFixture, setDashboardRole } from "./helpers/session";

test("owner can open every dashboard area without runtime errors", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  await installDashboardFixture(page);
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });

  const pages = [
    ["/overview", "Operations overview"],
    ["/jobs", "Jobs"],
    [`/jobs/${FIXTURE_IDS.job}`, "Fixture song"],
    ["/users", "Users"],
    [`/users/${FIXTURE_IDS.user}`, "Fixture Listener"],
    ["/abuse-events", "Abuse events"],
    ["/account-recovery", "Account recovery"],
    ["/releases", "Releases"],
    [`/releases/${FIXTURE_IDS.release}`, "2.0.0 (20)"],
    ["/update-policy", "Update policy"],
    ["/settings", "Standard account policy"],
    ["/workers", "Worker fleet"],
    [`/workers/${FIXTURE_IDS.workerMachine}`, "Windows Z440"],
    ["/health", "System health"],
    ["/activity", "Activity log"],
    ["/administrators", "Administrators"],
  ] as const;

  for (const [path, heading] of pages) {
    await page.goto(path);
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
  }
  expect(runtimeErrors).toEqual([]);
});

test("owner inspects worker detail and one-use enrollment is cleared", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  const fixture = await installDashboardFixture(page);

  await page.goto("/workers");
  await expect(page.getByRole("link", { name: /Windows Z440/ })).toBeVisible();
  await page.getByRole("link", { name: /Windows Z440/ }).click();
  await expect(
    page.getByRole("heading", { name: "Windows Z440", exact: true }),
  ).toBeVisible();
  await page.getByText(/runtime log/).click();
  await expect(page.getByText(/\[redacted-url\]/)).toBeVisible();
  await expect(page.getByText(/fixture-secret/)).toHaveCount(0);

  await page.goto("/workers");
  const trigger = page.getByRole("button", { name: "Create invitation" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Enroll a worker machine" });
  await dialog.getByLabel("Reason").fill("Enroll the Windows fixture");
  await dialog.getByRole("button", { name: "Verify identity" }).click();
  await dialog.getByRole("button", { name: "Create one-use code" }).click();
  const credentialDialog = page.getByRole("dialog", {
    name: "Save the one-use code",
  });
  await expect(
    credentialDialog.getByText("fixture-one-use-enrollment-secret"),
  ).toBeVisible();
  await credentialDialog
    .getByRole("button", { name: "I saved the code" })
    .click();
  await expect(credentialDialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(
    page.getByRole("dialog", { name: "Enroll a worker machine" }),
  ).not.toContainText("fixture-one-use-enrollment-secret");
  expect(
    fixture.requests.some(({ url }) =>
      url.includes("/admin/workers/invitations"),
    ),
  ).toBe(true);
});

test("support reviews a high-priority account recovery request", async ({
  page,
}) => {
  await setDashboardRole(page, "support");
  const fixture = await installDashboardFixture(page);

  await page.goto("/account-recovery");
  await expect(
    page
      .getByRole("navigation", { name: "Primary navigation" })
      .first()
      .getByRole("link", {
        name: "Account recovery: 1 pending high-priority requests",
      }),
  ).toBeVisible();
  await expect(
    page.getByText("I changed my mind and need access to my saved vocals."),
  ).toBeVisible();

  await page.getByRole("button", { name: "Recover account" }).click();
  const dialog = page.getByRole("dialog", { name: "Recover account" });
  await dialog
    .getByLabel("Reason")
    .fill("Verified the authenticated account owner's request");
  await dialog
    .getByRole("button", { name: "Reauthenticate with Google" })
    .click();
  await dialog.getByRole("button", { name: "Recover account" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("No recovery requests")).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Primary navigation" })
      .first()
      .getByRole("link", { name: "Account recovery", exact: true }),
  ).toBeVisible();
  expect(fixture.recovery.status).toBe("approved");
  expect(fixture.recovery.user.status).toBe("active");
});

test("jobs pagination follows opaque cursors and returns to the first page", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  const fixture = await installDashboardFixture(page);
  const secondJobId = "000000000000000000000003";
  await page.route(/\/admin\/jobs(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fallback();
      return;
    }
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    await route.fulfill({
      status: 200,
      headers: {
        "access-control-allow-origin": "http://127.0.0.1:4173",
        "content-type": "application/json",
      },
      body: JSON.stringify(
        toWireCase({
          items: [
            cursor
              ? { ...fixture.job, id: secondJobId, queuePosition: 2 }
              : fixture.job,
          ],
          nextCursor: cursor ? null : "fixture-next-page",
          asOf: "2026-09-11T00:00:00.000Z",
        }),
      ),
    });
  });

  await page.goto("/jobs");
  await expect(page.getByRole("link", { name: FIXTURE_IDS.job })).toBeVisible();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page).toHaveURL(/cursor=fixture-next-page/);
  await expect(page.getByRole("link", { name: secondJobId })).toBeVisible();
  await page.getByRole("button", { name: "Previous page" }).click();
  await expect(page).not.toHaveURL(/cursor=/);
  await expect(page.getByRole("link", { name: FIXTURE_IDS.job })).toBeVisible();
});

test("YouTube jobs show their canonical source URL in the list and detail", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  const fixture = createDashboardFixture();
  const sourceUrl = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
  Object.assign(fixture.job, { sourceUrl });
  await installDashboardFixture(page, fixture);

  await page.goto("/jobs");
  let source = page.getByRole("link", { name: sourceUrl });
  await expect(source).toBeVisible();
  await expect(source).toHaveAttribute("href", sourceUrl);
  await expect(source).toHaveAttribute("target", "_blank");

  await page.goto(`/jobs/${FIXTURE_IDS.job}`);
  source = page.getByRole("link", { name: sourceUrl });
  await expect(source).toBeVisible();
  await expect(source).toHaveAttribute("href", sourceUrl);
});

test("unsaved settings require a decision before in-app navigation", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  await installDashboardFixture(page);
  await page.goto("/settings");
  await page.getByRole("switch", { name: "Accept new jobs" }).click();

  await page.getByRole("link", { name: "Jobs" }).click();
  let dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Discard unsaved changes?");
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(page).toHaveURL(/\/settings$/);

  await page.getByRole("link", { name: "Jobs" }).click();
  dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Discard changes" }).click();
  await expect(page).toHaveURL(/\/jobs$/);
});

test("CSV downloads retain the active jobs and overview filters", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  const fixture = await installDashboardFixture(page);
  await page.goto("/jobs?status=processing");
  await expect(page.getByRole("heading", { name: "Jobs" })).toBeVisible();
  const jobsDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  expect((await jobsDownload).suggestedFilename()).toBe("musicmute-jobs.csv");
  expect(
    fixture.requests.some(
      ({ url }) =>
        url.includes("/admin/exports/jobs.csv") &&
        url.includes("status=processing"),
    ),
  ).toBe(true);

  const from = "2026-09-01T00:00:00.000Z";
  const to = "2026-09-11T00:00:00.000Z";
  await page.goto(
    `/overview?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  await expect(
    page.getByRole("heading", { name: "Operations overview" }),
  ).toBeVisible();
  const overviewDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV" }).click();
  expect((await overviewDownload).suggestedFilename()).toBe(
    "musicmute-overview.csv",
  );
  expect(
    fixture.requests.some(
      ({ url }) =>
        url.includes("/admin/exports/overview.csv") &&
        url.includes(encodeURIComponent(from)) &&
        url.includes(encodeURIComponent(to)) &&
        url.includes("bucket=day"),
    ),
  ).toBe(true);
});

test("owner completes administrator and alert workflows", async ({ page }) => {
  await setDashboardRole(page, "owner");
  const fixture = await installDashboardFixture(page);

  await page.goto("/administrators");
  await page.getByRole("button", { name: "Add administrator" }).click();
  let dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Verified Google email")
    .fill("new-admin@example.invalid");
  await dialog.getByLabel("Reason").fill("Add an operations viewer");
  await dialog
    .getByRole("button", { name: "Reauthenticate and review" })
    .click();
  await dialog.getByRole("button", { name: "Confirm administrator" }).click();
  await expect(dialog).toHaveCount(0);
  expect(
    fixture.requests.some(
      ({ method, url }) => method === "POST" && url.includes("/admin/access"),
    ),
  ).toBe(true);

  await page.goto("/health");
  await page.getByRole("button", { name: "Acknowledge" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason").fill("Incident is under investigation");
  await dialog.getByRole("button", { name: "Acknowledge" }).click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.alert.acknowledgedBy).toBe("owner-fixture");
});

test("owner withdraws a release with a replacement policy", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  const fixture = createDashboardFixture();
  await installDashboardFixture(page, fixture);

  await page.goto(`/update-policy?releaseId=${FIXTURE_IDS.publishedRelease}`);
  await page.getByLabel("Direct release ID").fill(FIXTURE_IDS.release);
  await page.getByRole("button", { name: "Preview policy" }).click();
  await expect(page.getByText("Policy is valid")).toBeVisible();
  await page.getByRole("button", { name: "Withdraw with replacement" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason").fill("Replace the superseded direct build");
  await dialog
    .getByRole("button", { name: "Reauthenticate with Google" })
    .click();
  await dialog.getByRole("button", { name: "Withdraw release" }).click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.releases[1].state).toBe("withdrawn");
  expect(fixture.policy.android.directReleaseId).toBe(FIXTURE_IDS.release);
});

test("support restricts an account, requests media deliberately, and cancels a job", async ({
  page,
}) => {
  await setDashboardRole(page, "support");
  const fixture = await installDashboardFixture(page);

  await page.goto(`/users/${FIXTURE_IDS.user}`);
  await page.getByRole("button", { name: "Restrict account" }).click();
  let dialog = page.getByRole("dialog");
  await dialog
    .getByRole("textbox", { name: "Reason" })
    .fill("Investigate an abuse report");
  await dialog
    .getByRole("button", { name: "Reauthenticate with Google" })
    .click();
  await dialog.getByRole("button", { name: "Restrict account" }).click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.restriction).toMatchObject({
    accountId: FIXTURE_IDS.user,
    status: "active",
    reasonCode: "manual_review",
  });

  await page.goto(`/jobs/${FIXTURE_IDS.job}`);
  expect(
    fixture.requests.filter(({ url }) => url.includes("media-grants")),
  ).toHaveLength(0);
  await page.getByRole("button", { name: "Play input" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason").fill("Verify the reported source audio");
  await dialog
    .getByRole("button", { name: "Reauthenticate and review" })
    .click();
  await dialog.getByRole("button", { name: "Confirm play" }).click();
  await expect(
    page.getByLabel(`input audio for job ${FIXTURE_IDS.job}`),
  ).toBeVisible();
  expect(
    fixture.requests.filter(({ url }) => url.includes("media-grants")),
  ).toHaveLength(1);

  await page.getByRole("button", { name: "Request cancellation" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason").fill("User requested cancellation");
  await dialog.getByRole("button", { name: "Request cancellation" }).click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.job.status).toBe("cancelled");
  await expect(page.getByText("cancelled", { exact: true })).toBeVisible();
});

test("owner uploads a direct APK, publishes verified policy, and saves settings", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  const fixture = createDashboardFixture();
  fixture.releases[0].artifactState = null;
  fixture.releases[0].bytes = null;
  fixture.releases[0].sha256Hex = null;
  await installDashboardFixture(page, fixture);
  await page.route("https://upload.fixture.invalid/", (route) =>
    route.fulfill({ status: 204, body: "" }),
  );

  await page.goto(`/releases/${FIXTURE_IDS.release}`);
  await page.getByLabel("APK file").setInputFiles({
    name: "fixture.apk",
    mimeType: "application/vnd.android.package-archive",
    buffer: Buffer.from("synthetic APK bytes for browser flow"),
  });
  await page.getByRole("button", { name: "Hash and upload" }).click();
  await expect(
    page.getByText("verified", { exact: true }).last(),
  ).toBeVisible();
  expect(fixture.releases[0].artifactState).toBe("verified");

  await page.goto(`/update-policy?releaseId=${FIXTURE_IDS.release}`);
  await page.getByRole("button", { name: "Preview policy" }).click();
  await expect(page.getByText("Policy is valid")).toBeVisible();
  await page.getByRole("button", { name: "Publish release" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason").fill("Publish verified browser fixture");
  await dialog
    .getByRole("button", { name: "Reauthenticate with Google" })
    .click();
  await dialog.getByRole("button", { name: "Publish release" }).click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.releases[0].state).toBe("published");
  expect(fixture.policy.revision).toBe(2);
  await expect(page.getByText("Current server revision 2.")).toBeVisible();

  await page.goto("/settings");
  await page.getByRole("switch", { name: "Accept new jobs" }).click();
  await page
    .getByLabel("Maintenance message, English")
    .fill("Processing is paused for maintenance.");
  await page.getByRole("button", { name: "Review changes" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason").fill("Pause new processing safely");
  await dialog
    .getByRole("button", { name: "Reauthenticate with Google" })
    .click();
  await dialog.getByRole("button", { name: "Save policy" }).click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.settings.acceptNewJobs).toBe(false);
  expect(fixture.settings.maintenanceMessageEn).toBe(
    "Processing is paused for maintenance.",
  );
  expect(fixture.settings.revision).toBe(2);
});

test("expired media requires a new reviewed grant", async ({ page }) => {
  await page.clock.install();
  await setDashboardRole(page, "support");
  const fixture = await installDashboardFixture(page);
  await page.goto(`/jobs/${FIXTURE_IDS.job}`);

  await page.getByRole("button", { name: "Play input" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason").fill("Review the reported source audio");
  await dialog
    .getByRole("button", { name: "Reauthenticate and review" })
    .click();
  await dialog.getByRole("button", { name: "Confirm play" }).click();
  await expect(
    page.getByLabel(`input audio for job ${FIXTURE_IDS.job}`),
  ).toBeVisible();

  await page.clock.fastForward(300_001);
  await expect(page.getByText("Media access expired.")).toBeVisible();
  await expect(
    page.getByLabel(`input audio for job ${FIXTURE_IDS.job}`),
  ).toHaveCount(0);
  expect(
    fixture.requests.filter(({ url }) => url.includes("media-grants")),
  ).toHaveLength(1);

  await page.clock.setFixedTime(new Date());
  await page.getByRole("button", { name: "Renew access" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason").fill("Renew after the prior grant expired");
  await dialog
    .getByRole("button", { name: "Reauthenticate and review" })
    .click();
  await dialog.getByRole("button", { name: "Confirm play" }).click();
  await expect(
    page.getByLabel(`input audio for job ${FIXTURE_IDS.job}`),
  ).toBeVisible();
  expect(
    fixture.requests.filter(({ url }) => url.includes("media-grants")),
  ).toHaveLength(2);
});

test("a lost settings response is reconciled through the operation receipt", async ({
  page,
}) => {
  await setDashboardRole(page, "owner");
  const fixture = await installDashboardFixture(page);
  let committedOperationId: string | null = null;
  await page.route(
    "**/admin/settings/account-policy",
    async (route, request) => {
      if (request.method() !== "PUT" || committedOperationId) {
        await route.fallback();
        return;
      }
      const body = fromWireCase(request.postDataJSON()) as {
        operationId: string;
      };
      committedOperationId = body.operationId;
      await fixture.handle({
        method: request.method(),
        url: request.url(),
        token: "owner-fixture",
        body,
      });
      await route.abort("connectionreset");
    },
  );
  await page.route("**/admin/operations/*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        toWireCase({
          operationId: committedOperationId,
          status: "succeeded",
          resourceId: "processing",
          revision: fixture.settings.revision,
          code: null,
        }),
      ),
    });
  });

  await page.goto("/settings");
  await page.getByRole("switch", { name: "Accept new jobs" }).click();
  await page
    .getByLabel("Maintenance message, English")
    .fill("Processing is paused during maintenance.");
  await page.getByRole("button", { name: "Review changes" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Reason").fill("Verify uncertain response recovery");
  await dialog
    .getByRole("button", { name: "Reauthenticate with Google" })
    .click();
  await dialog.getByRole("button", { name: "Save policy" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/revision 2/i)).toBeVisible();
  expect(committedOperationId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});
