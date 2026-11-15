import type { AccountUsageView } from "../shared/usage-contracts.js";
import { formatUsage } from "../shared/usage-presentation.js";
import { t, useLanguage } from "./i18n.js";
/** Read-only presentation; it neither authorizes work nor creates a polling/refresh action. */
export function UsagePanel({ view }: { view?: AccountUsageView }) {
  const locale = useLanguage(),
    text = {
      title: t("Cloud usage"),
      used: t("Used"),
      limit: t("Allowance"),
      remaining: t("Remaining"),
      reset: t("Resets"),
      loading: t("Loading cloud usage…"),
      unavailable: t(
        "Cloud usage is unavailable. Local processing remains available.",
      ),
      signin: t("Sign in to view your cloud allowance."),
      stale: t(
        "Showing previous usage while reconnecting. Cloud availability requires current account data.",
      ),
      resetOverdue: t(
        "The reset date has passed. Waiting for current account data.",
      ),
      connecting: t("Connecting…"),
      reconnecting: t("Reconnecting…"),
      stopped: t("Account connection unavailable"),
      live: t("Connected"),
      library: t("Library synchronization is still loading."),
      blocked: t("Cloud processing is currently unavailable."),
    },
    usage = view?.authenticated ? view.usage : null,
    formatted = usage ? formatUsage(usage, locale) : null,
    seconds = (value: number) =>
      new Intl.NumberFormat(locale, {
        style: "unit",
        unit: "second",
        unitDisplay: "long",
        maximumFractionDigits: 0,
      }).format(value);
  return (
    <section
      className="processing-panel"
      aria-label={text.title}
      dir={locale === "ar" ? "rtl" : "ltr"}
    >
      <h3>{text.title}</h3>
      {view?.authenticated && (
        <p role="status">
          {text[view.connection]}
          {!view.libraryReady && view.connection === "live"
            ? ` · ${text.library}`
            : ""}
        </p>
      )}
      {!view?.authenticated ? (
        <p role="status">{view ? text.signin : text.unavailable}</p>
      ) : view.usageState === "loading" ? (
        <p role="status">{text.loading}</p>
      ) : !usage || !formatted ? (
        <p role="status">{text.unavailable}</p>
      ) : (
        <>
          <p
            aria-label={t("{percent} of the cloud allowance used", {
              percent: formatted.percent,
            })}
          >
            {formatted.percent}
          </p>
          <dl>
            <dt>{text.used}</dt>
            <dd>{seconds(usage.usedSeconds)}</dd>
            <dt>{text.limit}</dt>
            <dd>{seconds(usage.limitSeconds)}</dd>
            <dt>{text.remaining}</dt>
            <dd>{formatted.remaining}</dd>
            <dt>{text.reset}</dt>
            <dd>
              <time dateTime={usage.resetAt}>{formatted.reset}</time>
            </dd>
          </dl>
          {view.usageState === "stale" && <p role="status">{text.stale}</p>}
          {usage.resetOverdue && <p role="status">{text.resetOverdue}</p>}
          {usage.availability === "blocked" && (
            <p role="status">{text.blocked}</p>
          )}
        </>
      )}
    </section>
  );
}
