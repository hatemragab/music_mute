import { ExternalLink, Laptop } from "lucide-react";
import { useI18n } from "../i18n";
import { MUSICMUTE_DOWNLOADS_URL } from "../product-links";

export function MacDownloadCallout({ className = "" }: { className?: string }) {
  const { t } = useI18n();

  return (
    <aside
      className={`platform-callout ${className}`.trim()}
      aria-label={t("macosAvailableTitle")}
    >
      <span className="platform-callout-icon" aria-hidden="true">
        <Laptop />
      </span>
      <div className="platform-callout-copy">
        <strong>{t("macosAvailableTitle")}</strong>
        <p>{t("macosAvailableBody")}</p>
      </div>
      <a
        className="platform-callout-link"
        href={MUSICMUTE_DOWNLOADS_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        <span>{t("macosDownloads")}</span>
        <ExternalLink aria-hidden="true" />
      </a>
    </aside>
  );
}
