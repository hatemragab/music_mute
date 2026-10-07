import { describe, expect, it } from "vitest";
import { createDashboardFixture } from "./dashboard-fixtures";

describe("worker registration dashboard fixture contract", () => {
  it.each(["owner", "support"])(
    "%s can approve new registrations without changing machines",
    async (role) => {
      const fixture = createDashboardFixture();
      const machine = structuredClone(fixture.workerMachine);
      const command = {
        workerRegistrationAllowed: true,
        expectedRevision: 1,
        operationId: "2bd185fb-d2d7-4c1e-82a8-63cfb6a7ed29",
        reason: "Approve registration",
      };
      const request = {
        method: "PUT",
        url: `/admin/users/${fixture.user.id}/worker-registration`,
        token: `${role}-fixture`,
        body: command,
      };
      expect(fixture.user.workerRegistrationAllowed).toBe(false);
      expect(await fixture.handle(request)).toMatchObject({
        status: 200,
        body: { status: "succeeded", resourceId: fixture.user.id, revision: 2 },
      });
      expect(fixture.user.workerRegistrationAllowed).toBe(true);
      expect(fixture.workerMachine).toEqual(machine);
      expect(await fixture.handle(request)).toMatchObject({ status: 200 });
      expect(fixture.user.revision).toBe(2);
      expect(
        await fixture.handle({
          ...request,
          body: { ...command, reason: "Different purpose" },
        }),
      ).toMatchObject({ status: 409 });
    },
  );

  it.each(["viewer", "release_manager"])(
    "%s is denied even with a forged request",
    async (role) => {
      const fixture = createDashboardFixture();
      expect(
        await fixture.handle({
          method: "PUT",
          url: `/admin/users/${fixture.user.id}/worker-registration`,
          token: `${role}-fixture`,
          body: { workerRegistrationAllowed: true },
        }),
      ).toMatchObject({ status: 403 });
      expect(fixture.user.workerRegistrationAllowed).toBe(false);
    },
  );

  it("rejects stale revisions and inactive accounts", async () => {
    const fixture = createDashboardFixture();
    const request = {
      method: "PUT",
      url: `/admin/users/${fixture.user.id}/worker-registration`,
      token: "owner-fixture",
      body: {
        workerRegistrationAllowed: true,
        expectedRevision: 0,
        operationId: "2bd185fb-d2d7-4c1e-82a8-63cfb6a7ed29",
        reason: "Approve registration",
      },
    };
    expect(await fixture.handle(request)).toMatchObject({ status: 409 });
    fixture.user.status = "deleting";
    request.body.expectedRevision = 1;
    expect(await fixture.handle(request)).toMatchObject({ status: 409 });
    expect(fixture.user.workerRegistrationAllowed).toBe(false);
  });
});
