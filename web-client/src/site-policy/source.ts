import catalog from "./data/supported-audio-sites.json";
import { ApiError } from "../api/client";

const exact = (pattern: string, value: string) =>
  new RegExp(`^(?:${pattern})$`).test(value);
export const supportedAudioSites = catalog.sites.map((site) => site.name);

/** Offline admission only. The server still verifies the actual media and redirects. */
export function supportedAudioUrl(raw: string): string {
  const value = raw.trim();
  const invalid = () => new ApiError(0, "IMPORT_INVALID_URL");
  if (!value || value.length > 2048 || /[^\x21-\x7e]|\\/.test(value))
    throw invalid();
  // Parse the original authority before URL() can erase a port, dot segment or escape.
  const parts = /^(https?):\/\/([a-zA-Z0-9.-]+)(\/[^?#]*)?(\?[^#]*)?$/i.exec(
    value,
  );
  if (!parts || /%(?![a-fA-F0-9]{2})/.test(value)) throw invalid();
  const host = parts[2].toLowerCase();
  const path = parts[3] || "/";
  if (
    /(?:^|\/)\.{1,2}(?:\/|$)|%(?:2e|2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(path)
  )
    throw invalid();
  const query = new Map<string, string>();
  try {
    for (const pair of (parts[4]?.slice(1) || "").split("&").filter(Boolean)) {
      const [key, ...rest] = pair.split("=");
      const name = decodeURIComponent(key.replace(/\+/g, " "));
      const content = decodeURIComponent(rest.join("=").replace(/\+/g, " "));
      if (
        query.has(name) ||
        [...(name + content)].some(
          (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
        )
      )
        throw invalid();
      query.set(name, content);
    }
  } catch {
    throw invalid();
  }
  const site = catalog.sites.find((site) =>
    site.rules.some(
      (rule) =>
        exact(rule.host, host) &&
        exact(rule.path, path) &&
        Object.entries(rule.requiredQuery).every(
          ([key, pattern]) =>
            typeof pattern === "string" && exact(pattern, query.get(key) || ""),
        ),
    ),
  );
  if (site?.id === "youtube") {
    const videoId = /^\/watch\/?$/.test(path)
      ? query.get("v") || ""
      : path.split("/").filter(Boolean).at(-1) || "";
    if (
      !/^[A-Za-z0-9_-]{11}$/.test(videoId) ||
      (query.has("v") && query.get("v") !== videoId)
    )
      throw invalid();
    // Share links may include a playlist, radio or timestamp; import only this video.
    return `https://www.youtube.com/watch?v=${videoId}`;
  }
  if (catalog.blockedQueryKeys.some((key) => query.has(key)))
    throw new ApiError(0, "IMPORT_SINGLE_ITEM_REQUIRED");
  if (!site) throw new ApiError(0, "IMPORT_UNSUPPORTED_PROVIDER");
  return `${parts[1].toLowerCase()}://${host}${path}${parts[4] || ""}`;
}
