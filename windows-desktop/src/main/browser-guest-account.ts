import type { BrowserAccountAuthorityOptions } from "./browser/account-contracts.js";
import type { AccountView } from "../shared/account-contracts.js";
import type { AccountUsageView } from "../shared/usage-contracts.js";

/** An unavailable account may expose guest cache, never credentials or cloud readiness. */
export function unconfiguredBrowserAccount(): Pick<
  BrowserAccountAuthorityOptions,
  "origin" | "account" | "usage" | "realtime"
> {
  const account: AccountView = {
      state: "signed-out",
      busy: false,
      online: false,
      googleSignInActive: false,
      user: null,
      devices: [],
      nextDeviceCursor: null,
      recovery: null,
      minimumBuild: null,
      access: { allowed: false, reason: "CONFIGURATION_REQUIRED" },
      verificationCooldownSeconds: 0,
      resetCooldownSeconds: 0,
      errorCode: "CONFIGURATION_REQUIRED",
      noticeCode: null,
    },
    usage: AccountUsageView = {
      connection: "stopped",
      authenticated: false,
      libraryReady: false,
      usageState: "unavailable",
      usage: null,
      policyState: "unavailable",
      policy: null,
      errorCode: "CONFIGURATION_REQUIRED",
    };
  const unavailable = (): never => {
    throw new Error("CONFIGURATION_REQUIRED");
  };
  return {
    origin: null,
    account: {
      view: () => structuredClone(account),
      sessionScope: () => null,
      assertScope: unavailable,
      authorization: async () => unavailable(),
      subscribe: (listener) => {
        listener(structuredClone(account));
        return () => {};
      },
    },
    usage: {
      view: () => structuredClone(usage),
      assertCloudSubmission: unavailable,
      subscribe: (listener) => {
        listener(structuredClone(usage));
        return () => {};
      },
    },
    realtime: { cloudLease: unavailable },
  };
}
