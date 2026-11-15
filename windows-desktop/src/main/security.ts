import type { ProductDestination } from "../shared/contracts.js";
export const UI_DOCUMENT = "musicmute://app/index.html";
export const PRODUCT_LINKS: Readonly<Record<ProductDestination, string>> =
  Object.freeze({
    web: "https://app.music-mute.com",
    downloads: "https://music-mute.com/#downloads",
    android:
      "https://play.google.com/store/apps/details?id=com.hatem.musicmute",
  });
export function trustedSender(
  url: string | undefined,
  isMainFrame: boolean,
): boolean {
  return isMainFrame && url === UI_DOCUMENT;
}
export function assetRelativePath(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "musicmute:" ||
      url.hostname !== "app" ||
      url.username ||
      url.password ||
      url.port ||
      url.search
    )
      return undefined;
    const path = decodeURIComponent(url.pathname);
    if (
      !/^\/[a-zA-Z0-9._/-]+$/.test(path) ||
      path.includes("..") ||
      path.includes("//")
    )
      return undefined;
    return path.slice(1);
  } catch {
    return undefined;
  }
}
