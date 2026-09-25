function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function convertCase(
  value: unknown,
  keyCase: (key: string) => string,
  parentKey?: string,
  requireWireKeys = false,
): unknown {
  if (Array.isArray(value))
    return value.map((item) =>
      convertCase(item, keyCase, parentKey, requireWireKeys),
    );
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (requireWireKeys && /[A-Z]/.test(key))
        throw new TypeError("API response contains a non-wire key");
      return [
        keyCase(key),
        key === "headers" || (parentKey === "signed" && key === "metadata")
          ? item
          : convertCase(item, keyCase, key, requireWireKeys),
      ];
    }),
  );
}

export function toWireCase(value: unknown): unknown {
  return convertCase(value, (key) =>
    key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
  );
}

export function fromWireCase(value: unknown): unknown {
  return convertCase(
    value,
    (key) =>
      key.replace(/_([a-z0-9])/g, (match, letter: string, offset: number) =>
        offset === 0 ? match : letter.toUpperCase(),
      ),
    undefined,
    true,
  );
}
