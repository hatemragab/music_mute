/** Larger on-disk Store build inventories need up to 30,000 leaves. This
 * dedicated receiving boundary retains grammar/decoded-key/finite-number/depth
 * checks and the Native inventory limits (8 MiB/400,000 nodes). Ordinary IPC
 * and HTTP parsers remain unchanged. Parsed data confers no OS authority. */
export function parseStoreBuildDocument(
  bytes: Uint8Array,
  maximum = 8 * 1024 ** 2,
): unknown {
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 8 * 1024 ** 2 ||
    bytes.byteLength < 1 ||
    bytes.byteLength > maximum
  )
    throw new Error("STORE_BUILD_JSON_INVALID");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    maxNodes = 400000;
  let at = 0,
    nodes = 0;
  const bad = (): never => {
    throw new Error("STORE_BUILD_JSON_INVALID");
  };
  const whitespace = () => {
    while (/[\t\n\r ]/u.test(text[at] ?? "x")) at++;
  };
  const string = (): string => {
    if (text[at] !== '"') bad();
    const begin = at++;
    while (at < text.length) {
      const c = text[at++]!;
      if (c === '"') {
        try {
          return JSON.parse(text.slice(begin, at)) as string;
        } catch {
          bad();
        }
      }
      if (c === "\\") at++;
      else if (c.charCodeAt(0) < 32) bad();
    }
    return bad();
  };
  const value = (depth: number): void => {
    if (depth > 32 || ++nodes > maxNodes) bad();
    whitespace();
    const c = text[at];
    if (c === '"') {
      string();
      return;
    }
    if (c === "{" || c === "[") {
      const object = c === "{",
        close = object ? "}" : "]",
        keys = new Set<string>();
      at++;
      whitespace();
      if (text[at] === close) {
        at++;
        return;
      }
      while (true) {
        if (object) {
          whitespace();
          const key = string();
          if (keys.has(key)) bad();
          keys.add(key);
          whitespace();
          if (text[at++] !== ":") bad();
        }
        value(depth + 1);
        whitespace();
        if (text[at] === close) {
          at++;
          return;
        }
        if (text[at++] !== ",") bad();
      }
    }
    for (const literal of ["true", "false", "null"])
      if (text.startsWith(literal, at)) {
        at += literal.length;
        return;
      }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
      text.slice(at),
    );
    if (!match || !Number.isFinite(Number(match[0]))) bad();
    at += match![0].length;
  };
  value(0);
  whitespace();
  if (at !== text.length) bad();
  try {
    return JSON.parse(text);
  } catch {
    return bad();
  }
}
