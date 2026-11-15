export type AccountProvider = "password" | "google.com" | "apple.com";
export interface AccountUserView {
  id: string;
  displayName: string;
  email: string | null;
  emailVerified: boolean;
  providers: AccountProvider[];
  workerRegistrationAllowed: boolean;
}
/** A visible provider may come from another client. Windows must retain at least
 * one method it can actually use to sign in again. */
export function canUnlinkWindowsProvider(
  user: AccountUserView,
  provider: "password" | "google.com",
): boolean {
  return (
    user.providers.includes(provider) &&
    user.providers.some(
      (value) =>
        value !== provider && (value === "password" || value === "google.com"),
    )
  );
}
export interface AccountDeviceView {
  installationId: string;
  platform: string;
  appVersion: string;
  buildNumber: number;
  metadataRevision: number;
  osVersion: string;
  deviceModel: string | null;
  lastSeenAt: string | null;
  current: boolean;
}
export interface AccountRecoveryView {
  accountStatus: string;
  recoverUntil: string | null;
  recoveryAvailable: boolean;
  requestStatus: string | null;
}
export interface AccountDestructiveReview {
  accountId: string;
  generation: string;
}
export interface AccountReviewedCommand {
  /** Legacy trusted internal calls may omit both; renderer ingress requires both. */
  expectedAccountId?: string;
  expectedSessionGeneration?: string;
}
export interface AccountView {
  state: "signed-out" | "restoring" | "signed-in" | "deletion-pending";
  busy: boolean;
  online: boolean;
  googleSignInActive: boolean;
  user: AccountUserView | null;
  devices: AccountDeviceView[];
  nextDeviceCursor: string | null;
  recovery: AccountRecoveryView | null;
  minimumBuild: number | null;
  access: { allowed: boolean; reason: string | null };
  verificationCooldownSeconds: number;
  resetCooldownSeconds: number;
  errorCode: string | null;
  noticeCode: string | null;
  destructiveReview?: AccountDestructiveReview;
}
/** Passwords are transient main-process command inputs, never presentation data. */
export type AccountCommand =
  | {
      type:
        | "RESTORE"
        | "CANCEL_SIGN_IN"
        | "LOGOUT"
        | "SEND_VERIFICATION"
        | "RECHECK_VERIFICATION"
        | "RECONNECT"
        | "LOAD_RECOVERY"
        | "REQUEST_RECOVERY";
    }
  | { type: "SIGN_IN_EMAIL"; email: string; password: string }
  | {
      type: "SIGN_UP_EMAIL";
      email: string;
      password: string;
      confirmation: string;
      name: string;
    }
  | { type: "SIGN_IN_GOOGLE"; link: boolean }
  | { type: "RESET_PASSWORD"; email: string }
  | { type: "REAUTHENTICATE"; password: string }
  | { type: "LINK_PASSWORD"; password: string; confirmation: string }
  | ({
      type: "UNLINK_PROVIDER";
      provider: "password" | "google.com";
      password: string;
      confirmed: true;
    } & AccountReviewedCommand)
  | ({ type: "LOGOUT_ALL"; confirmed: true } & AccountReviewedCommand)
  | ({
      type: "DELETE_ACCOUNT";
      password: string;
      confirmed: true;
    } & AccountReviewedCommand)
  | { type: "LOAD_DEVICES"; before?: string }
  | { type: "HIDE_DEVICE"; installationId: string };

const shapes: Record<string, readonly string[]> = {
  RESTORE: [],
  CANCEL_SIGN_IN: [],
  LOGOUT: [],
  SEND_VERIFICATION: [],
  RECHECK_VERIFICATION: [],
  RECONNECT: [],
  LOAD_RECOVERY: [],
  REQUEST_RECOVERY: [],
  SIGN_IN_EMAIL: ["email", "password"],
  SIGN_UP_EMAIL: ["email", "password", "confirmation", "name"],
  SIGN_IN_GOOGLE: ["link"],
  RESET_PASSWORD: ["email"],
  REAUTHENTICATE: ["password"],
  LINK_PASSWORD: ["password", "confirmation"],
  UNLINK_PROVIDER: [
    "provider",
    "password",
    "confirmed",
    "expectedAccountId",
    "expectedSessionGeneration",
  ],
  LOGOUT_ALL: ["confirmed", "expectedAccountId", "expectedSessionGeneration"],
  DELETE_ACCOUNT: [
    "password",
    "confirmed",
    "expectedAccountId",
    "expectedSessionGeneration",
  ],
  LOAD_DEVICES: ["before"],
  HIDE_DEVICE: ["installationId"],
};
export function parseAccountCommand(value: unknown): AccountCommand {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("INVALID_INPUT");
  const input = value as Record<string, unknown>;
  const fields =
    typeof input.type === "string" && Object.hasOwn(shapes, input.type)
      ? shapes[input.type]
      : undefined;
  if (
    !fields ||
    Object.keys(input).some((key) => key !== "type" && !fields.includes(key))
  )
    throw new TypeError("INVALID_INPUT");
  for (const key of fields) {
    const field = input[key];
    if (
      ["expectedAccountId", "expectedSessionGeneration"].includes(key) &&
      !Object.hasOwn(input, key)
    )
      continue;
    if (key === "before" && field === undefined) continue;
    if (key === "confirmed") {
      if (field !== true) throw new TypeError("CONFIRMATION_REQUIRED");
      continue;
    }
    if (key === "link") {
      if (typeof field !== "boolean") throw new TypeError("INVALID_INPUT");
      continue;
    }
    if (
      typeof field !== "string" ||
      field.length >
        (key === "password" || key === "confirmation"
          ? 4096
          : key === "email"
            ? 254
            : 100)
    )
      throw new TypeError("INVALID_INPUT");
    if (key === "provider" && !["password", "google.com"].includes(field))
      throw new TypeError("INVALID_INPUT");
    if (key === "before" && !/^[a-f0-9]{24}$/.test(field))
      throw new TypeError("INVALID_INPUT");
    if (key === "expectedAccountId" && !/^[a-f0-9]{24}$/u.test(field))
      throw new TypeError("INVALID_INPUT");
    if (
      key === "expectedSessionGeneration" &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
        field,
      )
    )
      throw new TypeError("INVALID_INPUT");
    if (
      key === "installationId" &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        field,
      )
    )
      throw new TypeError("INVALID_INPUT");
  }
  if (
    Object.hasOwn(input, "expectedAccountId") !==
    Object.hasOwn(input, "expectedSessionGeneration")
  )
    throw new TypeError("INVALID_INPUT");
  return structuredClone(input) as AccountCommand;
}
