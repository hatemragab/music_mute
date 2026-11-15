/** Retain only the original public thumbnail URL returned by the API. */
export function thumbnailUrl(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[^\x21-\x7e]|\\/.test(value) ||
    !/^https:\/\/i\.ytimg\.com\/vi(?:_webp)?\/[A-Za-z0-9_-]{11}\/[A-Za-z0-9_-]{1,64}\.(?:jpg|webp)(?:\?[^#]*)?$/.test(
      value,
    )
  )
    return null;
  const query = new URL(value).search.slice(1);
  if (!query) return value;
  const fields = query.split("&");
  if (fields.length > 2 || fields.some((field) => !field.includes("=")))
    return null;
  const parameters = new URLSearchParams(query);
  const names = new Set<string>();
  for (const [name, field] of parameters) {
    if (
      !["sqp", "rs"].includes(name) ||
      names.has(name) ||
      !/^[A-Za-z0-9_-]{1,1024}={0,2}$/.test(field)
    )
      return null;
    names.add(name);
  }
  return value;
}
