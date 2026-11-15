import type { AccountView } from "../../shared/account-contracts.js";
import type { FleetAccountPort } from "./controller.js";

const unavailable = (): AccountView => ({
  state: "signed-out",
  busy: false,
  online: false,
  googleSignInActive: false,
  user: null,
  devices: [],
  nextDeviceCursor: null,
  recovery: null,
  minimumBuild: null,
  access: { allowed: false, reason: "SIGN_IN_REQUIRED" },
  verificationCooldownSeconds: 0,
  resetCooldownSeconds: 0,
  errorCode: null,
  noticeCode: null,
});
/** Saved worker control does not require app login; enrollment still does. */
export function fleetAccountPort(
  read: () => { account: FleetAccountPort; origin: string } | null,
  approvedOrigin: string,
): FleetAccountPort {
  const current = () => {
    const value = read();
    return value?.origin === approvedOrigin ? value.account : null;
  };
  return {
    view: () => current()?.view() ?? unavailable(),
    sessionScope: () => current()?.sessionScope() ?? null,
    assertScope: (scope) => {
      const account = current();
      if (!account) throw new Error("FLEET_ACCOUNT_REQUIRED");
      account.assertScope(scope);
    },
    authorization: (force) => {
      const account = current();
      if (!account) return Promise.reject(new Error("FLEET_ACCOUNT_REQUIRED"));
      return account.authorization(force);
    },
  };
}
