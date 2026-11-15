/** Redact at producer boundaries and again before the private ingress writes. */
const sensitive =
  /(?:authorization|cookie|password|passwd|passphrase|token|secret|api.?key|private.?key|credential|access.?key|session.?id|refresh.?key|auth|connection.?string|database.?url|redis.?url|signed.?url|signature|ticket)/i;
export function redact(
  value,
  depth = 0,
  seen = new WeakSet(),
  budget = { nodes: 1500 },
) {
  if (--budget.nodes < 0 || depth > 9)
    return { omitted: "depth_or_node_limit" };
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    if (value.length > 16384)
      return { omitted: "string_limit", characters: value.length };
    const trimmed = value.trim();
    if (/^[[{]/.test(trimmed)) {
      try {
        return redact(JSON.parse(trimmed), depth + 1, seen, budget);
      } catch {}
    }
    if (value.length >= 16 && /^[A-Za-z0-9+/=_-]+$/.test(value)) {
      try {
        const decoded = Buffer.from(value, "base64").toString("utf8");
        if (/^[[{]/.test(decoded))
          return {
            encoding: "base64-json",
            value: redact(JSON.parse(decoded), depth + 1, seen, budget),
          };
      } catch {}
    }
    return value
      .replace(
        /-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?(?:-----END[\s\S]*?PRIVATE KEY-----|$)/g,
        "[REDACTED_KEY]",
      )
      .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, "[REDACTED_AUTH]")
      .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, "[REDACTED_JWT]")
      .replace(
        /(?:mongodb(?:\+srv)?|redis(?:s)?|postgres(?:ql)?|mysql):\/\/[^\s"'<>]+/gi,
        "[REDACTED_CONNECTION]",
      )
      .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, (candidate) => {
        try {
          const url = new URL(candidate);
          url.username = "";
          url.password = "";
          url.hash = "";
          for (const key of url.searchParams.keys())
            url.searchParams.set(key, "[REDACTED]");
          return url.href;
        } catch {
          return "[REDACTED_URL]";
        }
      })
      .replace(
        /([?&])[^\s&#=]*(?:token|secret|key|signature|credential|password|ticket)[^\s&#=]*=[^\s&#]*/gi,
        "$1credential=[REDACTED]",
      )
      .replace(
        /((?:password|passwd|token|secret|api[_-]?key|authorization|cookie|ticket)["'\s]*[:=]\s*)[^\s,;}]+/gi,
        "$1[REDACTED]",
      );
  }
  if (typeof value !== "object") return { omitted: "unsupported_type" };
  if (value instanceof Error)
    return {
      name: /^[\w.]+$/.test(value.name) ? value.name : "Error",
      code:
        typeof value.code === "string" && /^[A-Z_0-9-]{1,40}$/.test(value.code)
          ? value.code
          : undefined,
      omitted: "arbitrary_error_text",
    };
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value))
    return { omitted: "binary", bytes: value.byteLength };
  if (seen.has(value)) return { omitted: "circular" };
  seen.add(value);
  if (Array.isArray(value))
    return [
      ...value
        .slice(0, 64)
        .map((item) => redact(item, depth + 1, seen, budget)),
      ...(value.length > 64
        ? [{ omitted: "array_limit", count: value.length - 64 }]
        : []),
    ];
  const result = Object.create(null);
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) continue;
    result[
      sensitive.test(key)
        ? /^(?:authorization|cookie|set-cookie|password|passwd|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|private[_-]?key|client[_-]?secret|secret|access_key_id|session[_-]?id|ticket|signature)$/i.test(
            key,
          )
          ? key
          : "[REDACTED_FIELD]"
        : /^[A-Za-z0-9_.$-]{1,128}$/.test(key)
          ? key
          : "[OMITTED_FIELD]"
    ] = sensitive.test(key)
      ? "[REDACTED]"
      : /^(?:stack|errorMessage|message)$/i.test(key) &&
          /error/i.test(String(value.name ?? value.category ?? ""))
        ? { omitted: "arbitrary_error_text" }
        : redact(item, depth + 1, seen, budget);
  }
  if (Object.keys(value).length > 100) result.omission = "object_key_limit";
  return result;
}
export function boundedEvent(value, maximum = 65536) {
  const safe = redact(value);
  if (Buffer.byteLength(JSON.stringify(safe)) <= maximum) return safe;
  const {
    data: _data,
    payload: _payload,
    requestBody: _requestBody,
    responseBody: _responseBody,
    ...metadata
  } = safe;
  const result = {
    ...metadata,
    data: { omitted: "record_byte_limit" },
    payloadOmitted: true,
    omissionReason: "record_byte_limit",
  };
  if (Buffer.byteLength(JSON.stringify(result)) <= maximum) return result;
  return {
    timestamp: new Date().toISOString(),
    timestampSource: "collection",
    level: "warn",
    source: typeof safe.source === "string" ? safe.source : "collector",
    origin: "application_observation",
    instanceId:
      typeof safe.instanceId === "string"
        ? safe.instanceId.slice(0, 128)
        : "unknown",
    captureId:
      typeof safe.captureId === "string"
        ? safe.captureId.slice(0, 128)
        : undefined,
    requestId:
      typeof safe.requestId === "string" ? safe.requestId.slice(0, 128) : null,
    userId: typeof safe.userId === "string" ? safe.userId.slice(0, 128) : null,
    traceId:
      typeof safe.traceId === "string" ? safe.traceId.slice(0, 128) : undefined,
    name: "oversized_event",
    event: "oversized_event",
    summary: "Event metadata exceeded record limit",
    payloadOmitted: true,
    omissionReason: "record_byte_limit",
    data: { omitted: "record_byte_limit" },
  };
}
