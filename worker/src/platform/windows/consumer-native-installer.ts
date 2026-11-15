import {
  assertConsumerNonce,
  ConsumerNativeError,
  object,
  processIdentityFromWire,
  type ConsumerProcessIdentity,
} from "./consumer-native-policy.js";

export interface ConsumerInstallerPin {
  identity: string;
  sha256: string;
  bytes: number;
  publisherSha256: string;
}
export interface ConsumerInstallerLaunchCertificate {
  version: 1;
  nonce: string;
  pin: ConsumerInstallerPin;
  monitor: ConsumerProcessIdentity | null;
  process: ConsumerProcessIdentity | null;
  /** Observed primary exit status; app health must still be verified separately. */
  exitCode: number | null;
  treeExited: boolean;
}
export type ConsumerInstallerLaunchStatus =
  | { state: "absent"; certificate: null }
  | {
      state: "launching" | "running" | "completed" | "unknown";
      certificate: ConsumerInstallerLaunchCertificate;
    };

export function consumerInstallerArgs(
  pin: ConsumerInstallerPin,
): Record<string, unknown> {
  assertConsumerNonce(pin.identity);
  assertConsumerNonce(pin.sha256);
  assertConsumerNonce(pin.publisherSha256);
  if (
    !Number.isSafeInteger(pin.bytes) ||
    pin.bytes < 1 ||
    pin.bytes > 2 * 1024 ** 3
  )
    throw new ConsumerNativeError("BAD_REQUEST");
  return {
    identity: pin.identity,
    sha256: pin.sha256,
    bytes: pin.bytes,
    publisher_sha256: pin.publisherSha256,
  };
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new ConsumerNativeError("PROTOCOL_MISMATCH");
}
export function parseConsumerInstallerLaunch(
  value: unknown,
  expected: ConsumerInstallerPin,
  sid: string,
): ConsumerInstallerLaunchStatus {
  const row = object(value);
  exactKeys(row, ["state", "certificate"]);
  if (row.state === "absent") {
    if (row.certificate !== null)
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return { state: "absent", certificate: null };
  }
  if (
    row.state !== "launching" &&
    row.state !== "running" &&
    row.state !== "completed" &&
    row.state !== "unknown"
  )
    throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  const certificate = object(row.certificate);
  exactKeys(certificate, [
    "version",
    "nonce",
    "pin",
    "monitor",
    "process",
    "exit_code",
    "tree_exited",
  ]);
  if (certificate.version !== 1 || typeof certificate.nonce !== "string")
    throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  assertConsumerNonce(certificate.nonce);
  const wirePin = object(certificate.pin),
    expectedPin = consumerInstallerArgs(expected);
  exactKeys(wirePin, Object.keys(expectedPin));
  if (Object.keys(expectedPin).some((key) => wirePin[key] !== expectedPin[key]))
    throw new ConsumerNativeError("PEER_DENIED");
  const monitor =
      certificate.monitor === null
        ? null
        : processIdentityFromWire(certificate.monitor),
    process =
      certificate.process === null
        ? null
        : processIdentityFromWire(certificate.process);
  if ([monitor, process].some((identity) => identity && identity.sid !== sid))
    throw new ConsumerNativeError("PEER_DENIED");
  if (row.state === "completed") {
    if (
      !monitor ||
      !process ||
      certificate.tree_exited !== true ||
      typeof certificate.exit_code !== "number" ||
      !Number.isInteger(certificate.exit_code) ||
      certificate.exit_code < 0 ||
      certificate.exit_code > 0xffffffff
    )
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  } else if (
    certificate.exit_code !== null ||
    certificate.tree_exited !== false
  )
    throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  if (row.state === "running" && (!monitor || !process))
    throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  return {
    state: row.state,
    certificate: {
      version: 1,
      nonce: certificate.nonce,
      pin: structuredClone(expected),
      monitor,
      process,
      exitCode: certificate.exit_code as number | null,
      treeExited: certificate.tree_exited as boolean,
    },
  };
}
