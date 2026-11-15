import { expect, it, vi } from "vitest";
import { fleetAccountPort } from "../src/main/fleet/account-port.js";
import type { FleetAccountPort } from "../src/main/fleet/controller.js";
it("keeps enrollment unavailable while existing worker controls need no app account", async () => {
  const port = fleetAccountPort(() => null, "https://api.example.test");
  expect(port.sessionScope()).toBeNull();
  expect(port.view().googleSignInActive).toBe(false);
  expect(port.view().access.allowed).toBe(false);
  await expect(port.authorization()).rejects.toThrow("FLEET_ACCOUNT_REQUIRED");
});
it("binds tokens only to the approved account origin and reads replacement account dynamically", async () => {
  const fallback = fleetAccountPort(() => null, "https://api.example.test");
  const auth = vi.fn(async () => "private-fixture");
  const account: FleetAccountPort = { ...fallback, authorization: auth };
  let selected = { account, origin: "https://other.example.test" };
  const port = fleetAccountPort(() => selected, "https://api.example.test");
  await expect(port.authorization()).rejects.toThrow("FLEET_ACCOUNT_REQUIRED");
  expect(auth).not.toHaveBeenCalled();
  selected = { account, origin: "https://api.example.test" };
  expect(await port.authorization(true)).toBe("private-fixture");
  expect(auth).toHaveBeenCalledWith(true);
});
