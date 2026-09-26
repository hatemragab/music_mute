import { useSyncExternalStore } from "react";
import type { JobView } from "../api/types";
import { useI18n } from "../i18n";
import { useRealtime } from "../realtime/RealtimeProvider";

export function QueuePosition({ job }: { job: JobView }) {
  const { lang, t } = useI18n();
  const client = useRealtime();
  const state = useSyncExternalStore(client.onState, client.getState);
  if (job.status !== "queued") return null;
  if (state !== "live")
    return <p className="muted">{t("updatesReconnecting")}</p>;
  const queue = job.queue;
  const arabic = lang === "ar";
  const number = (value: number) => new Intl.NumberFormat(lang).format(value);
  const ahead = queue?.jobsAhead ?? 0;
  const arabicAhead = new Intl.PluralRules("ar").select(ahead);
  const aheadLabel =
    arabicAhead === "one"
      ? "مهمة واحدة قبلك"
      : arabicAhead === "two"
        ? "مهمتان قبلك"
        : `${number(ahead)} ${arabicAhead === "few" ? "مهام" : "مهمة"} قبلك`;
  if (queue?.state === "waiting" && queue.position != null)
    return (
      <div className="queue-position">
        <strong>
          {arabic
            ? `رقم ${number(queue.position)} في الانتظار`
            : `#${number(queue.position)} in queue`}
        </strong>
        <small>
          {queue.jobsAhead
            ? arabic
              ? aheadLabel
              : `${number(queue.jobsAhead)} ${queue.jobsAhead === 1 ? "job" : "jobs"} ahead`
            : arabic
              ? "في انتظار دور المعالجة"
              : "Waiting for a processing slot"}
        </small>
      </div>
    );
  const reason = queue?.reason;
  const label =
    reason === "account_capacity"
      ? arabic
        ? "في انتظار انتهاء مهمتك الحالية"
        : "Waiting for your current job to finish"
      : reason === "retry_backoff"
        ? arabic
          ? "في انتظار إعادة المحاولة"
          : "Waiting to retry"
        : reason === "processing_paused"
          ? arabic
            ? "المعالجة متوقفة مؤقتاً"
            : "Processing is temporarily paused"
          : reason === "worker_unavailable"
            ? arabic
              ? "في انتظار توفر المعالجة"
              : "Waiting for processing capacity"
            : arabic
              ? "رقم الانتظار غير متاح حالياً"
              : "Queue position temporarily unavailable";
  return <p className="muted">{label}</p>;
}
