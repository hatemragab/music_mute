import {
  ConsumerNativeError,
  object,
  processIdentityFromWire,
  assertConsumerNonce,
  type ConsumerOwnedProcess,
} from "./consumer-native-policy.js";
import {
  parseConsumerShareReceipt,
  type ConsumerShareReceipt,
} from "./consumer-native-share.js";

export type ConsumerNativeEvent =
  | { sequence: number; kind: "share"; receipt: ConsumerShareReceipt }
  | {
      sequence: number;
      kind: "session";
      event:
        | "lock"
        | "unlock"
        | "suspend"
        | "resume"
        | "network"
        | "ending_requested"
        | "ending";
    }
  | { sequence: number; kind: "child_exit"; owner: ConsumerOwnedProcess };

export function parseConsumerNativeEvent(value: unknown): ConsumerNativeEvent {
  const input = object(value);
  if (!Number.isSafeInteger(input.sequence) || (input.sequence as number) < 1)
    throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  if (input.kind === "share") {
    if (Object.keys(input).sort().join() !== "kind,receipt,sequence")
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return {
      sequence: input.sequence as number,
      kind: "share",
      receipt: parseConsumerShareReceipt(input.receipt),
    };
  }
  if (input.kind === "session") {
    if (
      ![
        "lock",
        "unlock",
        "suspend",
        "resume",
        "network",
        "ending_requested",
        "ending",
      ].includes(input.event as string) ||
      Object.keys(input).sort().join() !== "event,kind,sequence"
    )
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    return {
      sequence: input.sequence as number,
      kind: "session",
      event: input.event as Extract<
        ConsumerNativeEvent,
        { kind: "session" }
      >["event"],
    };
  }
  if (input.kind === "child_exit") {
    if (Object.keys(input).sort().join() !== "kind,owner,sequence")
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    const owner = object(input.owner);
    if (
      !["session-agent", "personal", "fleet", "prepare"].includes(
        owner.role as string,
      ) ||
      typeof owner.nonce !== "string" ||
      Object.keys(owner).sort().join() !== "identity,nonce,role"
    )
      throw new ConsumerNativeError("PROTOCOL_MISMATCH");
    assertConsumerNonce(owner.nonce);
    return {
      sequence: input.sequence as number,
      kind: "child_exit",
      owner: {
        role: owner.role as ConsumerOwnedProcess["role"],
        nonce: owner.nonce,
        identity: processIdentityFromWire(owner.identity),
      },
    };
  }
  throw new ConsumerNativeError("PROTOCOL_MISMATCH");
}
