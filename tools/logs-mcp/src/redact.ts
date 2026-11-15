/** Defense in depth for untrusted retained records, before any MCP serialization. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 9) return { omitted: "depth_limit" };
  if (typeof value === "string") {
    if (value.length > 16384) return { omitted: "string_limit" };
    try {
      if (/^[[{]/.test(value.trim()))
        return redact(JSON.parse(value), depth + 1);
    } catch {
      /* plain text */
    }
    if (value.length >= 16 && /^[A-Za-z0-9+/=_-]+$/.test(value)) {
      try {
        const decoded = Buffer.from(value, "base64").toString("utf8");
        if (/^[[{]/.test(decoded))
          return {
            encoding: "base64-json",
            value: redact(JSON.parse(decoded), depth + 1),
          };
      } catch {
        /* not encoded JSON */
      }
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
  if (Array.isArray(value))
    return value.slice(0, 64).map((item) => redact(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .filter(
          ([key]) => !["__proto__", "constructor", "prototype"].includes(key),
        )
        .map(([key, item]) => [
          /authorization|cookie|password|passwd|token|secret|api.?key|private.?key|credential|access.?key|session.?id|auth|signature|ticket/i.test(
            key,
          )
            ? /^(?:authorization|cookie|set-cookie|password|passwd|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|private[_-]?key|client[_-]?secret|secret|access_key_id|session[_-]?id|ticket|signature)$/i.test(
                key,
              )
              ? key
              : "[REDACTED_FIELD]"
            : /^[A-Za-z0-9_.$-]{1,128}$/.test(key)
              ? key
              : "[OMITTED_FIELD]",
          /(?:authorization|cookie|password|passwd|token|secret|api.?key|private.?key|credential|access.?key|session.?id|auth|connection.?string|signature|ticket)/i.test(
            key,
          )
            ? "[REDACTED]"
            : redact(item, depth + 1),
        ]),
    );
  return value;
}
