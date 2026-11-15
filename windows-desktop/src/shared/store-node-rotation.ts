import { processIdentityFromWire } from "../../../worker/src/platform/windows/consumer-native-policy.js";
import type { ConsumerProcessIdentity } from "../../../worker/src/platform/windows/consumer-native.js";
const SECRET = /^[a-f0-9]{64}$/u;
function denied(): never {
  throw new Error("STORE_NODE_ISSUER_DENIED");
}
/** Receiving data only: the production issuer retains the original inherited
 * capability and native-attested Node/Creator privately. No reply mints a role. */
export function parseStoreNodeRotation(
  value: unknown,
  expected: {
    nonce: string;
    previous: string;
    node: ConsumerProcessIdentity;
    creator: { pid: number; creationTime: string };
  },
) {
  try {
    const fields = [
      "accepted",
      "capability",
      "creation_time",
      "creator_creation_time",
      "creator_pid",
      "node_creation_time",
      "node_pid",
      "pid",
      "remaining",
      "request_nonce",
      "rotated",
      "version",
    ];
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      denied();
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      denied();
    const parsed: Record<string, unknown> = Object.create(null);
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor?.enumerable || !("value" in descriptor)) denied();
      parsed[field] = descriptor.value;
    }
    processIdentityFromWire({
      sid: expected.node.sid,
      session_id: expected.node.sessionId,
      pid: expected.node.pid,
      creation_time: expected.node.creationTime,
    });
    processIdentityFromWire({
      sid: expected.node.sid,
      session_id: expected.node.sessionId,
      pid: expected.creator.pid,
      creation_time: expected.creator.creationTime,
    });
    if (expected.node.pid === expected.creator.pid) denied();
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join() !==
        "accepted,capability,creation_time,creator_creation_time,creator_pid,node_creation_time,node_pid,pid,remaining,request_nonce,rotated,version" ||
      !SECRET.test(expected.nonce) ||
      !SECRET.test(expected.previous) ||
      parsed.version !== 1 ||
      parsed.accepted !== true ||
      parsed.request_nonce !== expected.nonce ||
      parsed.pid !== expected.node.pid ||
      parsed.node_pid !== expected.node.pid ||
      parsed.creation_time !== expected.node.creationTime ||
      parsed.node_creation_time !== expected.node.creationTime ||
      parsed.creator_pid !== expected.creator.pid ||
      parsed.creator_creation_time !== expected.creator.creationTime ||
      typeof parsed.capability !== "string" ||
      !SECRET.test(parsed.capability) ||
      typeof parsed.rotated !== "boolean" ||
      !Number.isSafeInteger(parsed.remaining) ||
      (parsed.remaining as number) < 1 ||
      (parsed.remaining as number) > 2048 ||
      (parsed.rotated
        ? parsed.remaining !== 2048 || parsed.capability === expected.previous
        : parsed.capability !== expected.previous)
    )
      denied();
    return Object.freeze({
      capability: parsed.capability,
      rotated: parsed.rotated,
      remaining: parsed.remaining as number,
    });
  } catch {
    return denied();
  }
}
