import { describe, expect, it } from "vitest";
import { createDashboardFixture, FIXTURE_IDS } from "./dashboard-fixtures";

const body = (fixture: ReturnType<typeof createDashboardFixture>) => ({
  operationId: "4ba66f9c-5cc6-4f83-a302-b81bedc49c11",
  expectedRevision: fixture.workerMachine.revision,
  expectedUserRevision: fixture.user.revision,
  registrationUserId: fixture.user.id,
  reason: "Retire the synthetic machine",
});
const deletionUrl = `/admin/workers/machines/${FIXTURE_IDS.workerMachine}/deletions`;
describe("worker deletion fixtures", () => {
  it("hides a deleted machine, disables selected approval and replays one receipt", async () => {
    const fixture = createDashboardFixture();
    fixture.workerMachine.registeredByUserId = fixture.user.id;
    fixture.user.workerRegistrationAllowed = true;
    const input = body(fixture);
    const deleted = await fixture.handle({
      method: "POST",
      url: deletionUrl,
      token: "owner-fixture",
      body: input,
    });
    expect(deleted.status).toBe(200);
    expect(fixture.user.workerRegistrationAllowed).toBe(false);
    expect(fixture.workerDeleted).toBe(true);
    expect(
      (
        await fixture.handle({
          method: "GET",
          url: "/admin/worker-fleet/machines",
          token: "owner-fixture",
        })
      ).body,
    ).toMatchObject({ items: [] });
    expect(
      (
        await fixture.handle({
          method: "GET",
          url: `/admin/worker-fleet/machines/${FIXTURE_IDS.workerMachine}`,
          token: "owner-fixture",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fixture.handle({
          method: "POST",
          url: deletionUrl,
          token: "owner-fixture",
          body: input,
        })
      ).body,
    ).toEqual(deleted.body);
    expect(fixture.user.revision).toBe(input.expectedUserRevision + 1);
  });
  it.each(["support", "viewer", "release_manager"])(
    "rejects forged deletion by %s",
    async (role) => {
      const fixture = createDashboardFixture();
      expect(
        (
          await fixture.handle({
            method: "POST",
            url: deletionUrl,
            token: `${role}-fixture`,
            body: body(fixture),
          })
        ).status,
      ).toBe(403);
      expect(fixture.workerDeleted).toBe(false);
    },
  );
  it("requires explicit legacy selection and rejects both revision conflicts without writes", async () => {
    const fixture = createDashboardFixture();
    fixture.workerMachine.registeredByUserId = null;
    const input = body(fixture);
    const missing = {
      operationId: input.operationId,
      expectedRevision: input.expectedRevision,
      expectedUserRevision: input.expectedUserRevision,
      reason: input.reason,
    };
    expect(
      (
        await fixture.handle({
          method: "POST",
          url: deletionUrl,
          token: "owner-fixture",
          body: missing,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fixture.handle({
          method: "POST",
          url: deletionUrl,
          token: "owner-fixture",
          body: {
            ...input,
            expectedUserRevision: input.expectedUserRevision + 1,
          },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await fixture.handle({
          method: "POST",
          url: deletionUrl,
          token: "owner-fixture",
          body: { ...input, expectedRevision: input.expectedRevision + 1 },
        })
      ).status,
    ).toBe(409);
    expect(fixture.workerDeleted).toBe(false);
    expect(fixture.user.revision).toBe(input.expectedUserRevision);
  });
});
