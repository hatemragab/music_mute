/** Original public YouTube thumbnail URL only; never a media delivery URL. */
export function publicThumbnailUrl(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[^\x21-\x7e]|[\\#]/.test(value) ||
    !/^https:\/\/i\.ytimg\.com\/vi(?:_webp)?\/[A-Za-z0-9_-]{11}\/[A-Za-z0-9_-]{1,64}\.(?:jpg|webp)(?:\?.*)?$/.test(
      value,
    )
  )
    return null;
  try {
    const url = new URL(value);
    const parameters = [...url.searchParams];
    if (
      parameters.length > 2 ||
      (url.search &&
        url.search
          .slice(1)
          .split("&")
          .some((part) => !part))
    )
      return null;
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
  } catch {
    return null;
  }
}
