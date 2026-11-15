import { expect, it } from "vitest";
import { unconfiguredBrowserAccount } from "../src/main/browser-guest-account.js";
it("reports absent account configuration honestly and cannot issue a bearer, scope or cloud lease", async () => {
  const ports = unconfiguredBrowserAccount();
  expect(ports.origin).toBeNull();
  expect(ports.account.sessionScope()).toBeNull();
  expect(ports.account.view()).toMatchObject({
    state: "signed-out",
    user: null,
    online: false,
    access: { allowed: false },
  });
  await expect(ports.account.authorization()).rejects.toThrow(
    "CONFIGURATION_REQUIRED",
  );
  const scope = { firebaseUid: "foreign", generation: "foreign" };
  expect(() => ports.account.assertScope(scope)).toThrow(
    "CONFIGURATION_REQUIRED",
  );
  expect(() => ports.realtime.cloudLease(scope)).toThrow(
    "CONFIGURATION_REQUIRED",
  );
  expect(() => ports.usage.assertCloudSubmission(ports.account.view())).toThrow(
    "CONFIGURATION_REQUIRED",
  );
});
it("does not allow observers to mutate the static unavailable state", () => {
  const ports = unconfiguredBrowserAccount();
  ports.account.subscribe((view) => {
    view.state = "signed-in";
  });
  expect(ports.account.view().state).toBe("signed-out");
  ports.usage.subscribe((view) => {
    view.authenticated = true;
  });
  expect(ports.usage.view().authenticated).toBe(false);
});
