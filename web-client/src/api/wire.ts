const keyToWire = (key: string) =>
  key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const keyFromWire = (key: string) =>
  key.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());

function convert(
  value: unknown,
  keyTransform: (key: string) => string,
  parent = "",
): unknown {
  if (Array.isArray(value))
    return value.map((entry) => convert(entry, keyTransform, parent));
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      keyTransform(key),
      key === "headers" || (parent === "signed" && key === "metadata")
        ? item
        : convert(item, keyTransform, key),
    ]),
  );
}

export const toWire = (value: unknown): unknown => convert(value, keyToWire);
export const fromWire = (value: unknown): unknown =>
  convert(value, keyFromWire);
