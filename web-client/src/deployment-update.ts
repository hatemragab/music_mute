const selector = 'meta[name="musicmute-build"]';
const retryKey = "musicmute.deployment-reload";

function buildVersion(page: Document): string | undefined {
  const value = page.querySelector(selector)?.getAttribute("content");
  return value && /^[a-f0-9-]{36}$/.test(value) ? value : undefined;
}

export function reloadBlocked(): boolean {
  return (
    !!document.querySelector('[data-reload-blocked="true"]') ||
    [
      ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        "input, textarea",
      ),
    ].some((field) =>
      field instanceof HTMLTextAreaElement
        ? !!field.value
        : ![
            "checkbox",
            "radio",
            "range",
            "submit",
            "button",
            "hidden",
          ].includes(field.type) && !!field.value,
    ) ||
    [...document.querySelectorAll("audio, video")].some(
      (media) =>
        media instanceof HTMLMediaElement && !media.paused && !media.ended,
    )
  );
}

function isHidden() {
  return document.visibilityState === "hidden";
}

/** Compare against the loaded HTML, never a baseline fetched after deployment. */
export function watchDeployment({
  fetchPage = window.fetch.bind(window),
  reload = () => window.location.reload(),
  blocked = reloadBlocked,
} = {}): () => void {
  const current = buildVersion(document) ?? "";
  if (!current) return () => {}; // Development and pre-monitor builds.
  let stopped = false;
  let reloading = false;
  let inFlight = false;
  let controller: AbortController | undefined;

  async function check() {
    if (stopped || reloading || inFlight || isHidden() || !navigator.onLine)
      return;
    inFlight = true;
    controller = new AbortController();
    const timeout = window.setTimeout(() => controller?.abort(), 10_000);
    try {
      const response = await fetchPage(`/?deployment-check=${Date.now()}`, {
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
      });
      if (
        !response.ok ||
        !response.headers.get("content-type")?.includes("text/html")
      )
        return;
      const version = buildVersion(
        new DOMParser().parseFromString(await response.text(), "text/html"),
      );
      if (stopped || !version || version === current || isHidden() || blocked())
        return;
      // Limit automatic reloads if a proxy serves stale HTML or deployment replicas disagree.
      try {
        if (sessionStorage.getItem(retryKey) === current) return;
        const lastReload = Number(
          sessionStorage.getItem(`${retryKey}.at`) || 0,
        );
        if (Date.now() - lastReload < 300_000) return;
        sessionStorage.setItem(retryKey, current);
        sessionStorage.setItem(`${retryKey}.at`, String(Date.now()));
      } catch {
        return; // Without persistent loop protection, leave manual refresh available.
      }
      reloading = true;
      reload();
    } catch {
      // Offline, timeout or a transient deployment failure: try again later.
    } finally {
      window.clearTimeout(timeout);
      inFlight = false;
    }
  }
  const onActive = () => void check();
  const timer = window.setInterval(onActive, 60_000);
  window.addEventListener("focus", onActive);
  window.addEventListener("online", onActive);
  document.addEventListener("visibilitychange", onActive);
  onActive();
  return () => {
    stopped = true;
    controller?.abort();
    window.clearInterval(timer);
    window.removeEventListener("focus", onActive);
    window.removeEventListener("online", onActive);
    document.removeEventListener("visibilitychange", onActive);
  };
}
