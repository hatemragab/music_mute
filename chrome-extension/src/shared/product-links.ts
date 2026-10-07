/** Verified public destinations; never include account sessions or tracking data. */
export const PRODUCT_LINKS = Object.freeze({
  companionRelease:
    "https://github.com/ahmed-dev-1/musicmute-downloads/releases/tag/macos-store-companion-2026-10-07",
});

export function configureProductLink(
  link: HTMLAnchorElement,
  destination: keyof typeof PRODUCT_LINKS,
): void {
  link.href = PRODUCT_LINKS[destination];
  link.target = "_blank";
  link.rel = "noopener noreferrer";
}
