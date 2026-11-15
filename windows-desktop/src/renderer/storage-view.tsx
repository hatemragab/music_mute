import { useEffect, useRef, useState } from "react";
import { ModalDialog } from "./dialog.js";
import { t, useLanguage } from "./i18n.js";
import type {
  StorageCommand,
  StorageView,
  StorageCleanupTarget,
  StorageCategory,
} from "../shared/storage-contracts.js";
const categoryLabels: Record<StorageCategory, string> = {
  voices: "Saved voices",
  originals: "Saved originals",
  thumbnails: "Artwork",
  scratch: "Temporary processing files",
  outbox: "Pending account saves",
  runtime: "Processing tools",
  models: "Voice models",
  rollback: "Recovery releases",
  metadata: "Library information",
  unmanaged: "Unrecognized files",
};
export function StoragePanel({
  view,
  busy,
  execute,
}: {
  view?: StorageView;
  busy: boolean;
  execute(command: StorageCommand): Promise<void>;
}) {
  const language = useLanguage(),
    [draft, setDraft] = useState("2"),
    [dirty, setDirty] = useState(false),
    [pendingBudget, setPendingBudget] = useState<number>(),
    [target, setTarget] = useState<StorageCleanupTarget>();
  const initialScan = useRef(false);
  useEffect(() => {
    if (busy || initialScan.current) return;
    initialScan.current = true;
    void execute({ type: "SCAN" });
  }, [busy]);
  useEffect(() => {
    if (
      view?.state === "ready" &&
      (!dirty || view.budgetBytes === pendingBudget)
    ) {
      setDraft(String(view.budgetBytes / 1_000_000_000));
      setDirty(false);
      setPendingBudget(undefined);
    }
  }, [view?.budgetBytes, view?.state, dirty, pendingBudget]);
  const normalized = draft
      .trim()
      .replace(/[٠-٩]/g, (char) => String(char.charCodeAt(0) - 0x660)),
    gb = /^[1-9][0-9]{0,6}$/.test(normalized) ? Number(normalized) : NaN,
    valid = Number.isSafeInteger(gb) && gb <= 9007199;
  const bytes = (value: number) =>
    `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value / (value >= 1_000_000_000 ? 1_000_000_000 : 1_000_000))} ${value >= 1_000_000_000 ? "GB" : "MB"}`;
  return (
    <section className="panel" aria-label={t("Storage")}>
      <h2>{t("Storage")}</h2>
      <p>
        {t(
          "The 2 GB default covers saved voices. Originals, pending saves, processing tools, and models are counted separately.",
        )}
      </p>
      {!view || view.state === "loading" ? (
        <p role="status">{t("Checking storage…")}</p>
      ) : view.state === "error" ? (
        <p role="alert">
          {t(
            "Storage information is unavailable. Retry after current operations finish.",
          )}
        </p>
      ) : (
        <>
          <label>
            {t("Offline voice storage limit in GB")}
            <input
              inputMode="numeric"
              value={draft}
              maxLength={7}
              onChange={(event) => {
                setDraft(event.target.value);
                setDirty(true);
                setPendingBudget(undefined);
              }}
              disabled={busy}
            />
          </label>
          {!valid && (
            <p role="alert">
              {t("Enter a whole number from 1 to 9,007,199 GB.")}
            </p>
          )}
          <div className="home-links">
            <button
              disabled={busy || !valid}
              onClick={() => {
                setPendingBudget(gb * 1_000_000_000);
                void execute({
                  type: "SET_BUDGET",
                  budgetBytes: gb * 1_000_000_000,
                });
              }}
            >
              {t("Save storage limit")}
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setDraft("2");
                setDirty(true);
                setPendingBudget(2_000_000_000);
                void execute({
                  type: "SET_BUDGET",
                  budgetBytes: 2_000_000_000,
                });
              }}
            >
              {t("Use default 2 GB")}
            </button>
          </div>
          <p className="muted">
            {t(
              "Lowering the limit removes older unused voices when more space is needed. Active playback and pending saves remain protected.",
            )}
          </p>
          {view.lowSpace && (
            <p role="alert">
              {t("Disk space is low. Free space before starting more work.")}
            </p>
          )}
          {view.overBudget && (
            <p role="status">
              {t(
                "The voice cache is above its limit. Protected audio is retained.",
              )}
            </p>
          )}
          <dl className="storage-usage">
            {view.categories.map((category) => (
              <div key={category.category}>
                <dt>{t(categoryLabels[category.category])}</dt>
                <dd>
                  {bytes(category.bytes)}
                  {category.pinnedBytes > 0
                    ? ` · ${t("Protected")} ${bytes(category.pinnedBytes)}`
                    : ""}
                </dd>
              </div>
            ))}
          </dl>
          {view.freeBytes !== null && (
            <p>
              {t("Free disk space")}: <bdi>{bytes(view.freeBytes)}</bdi>
            </p>
          )}
          <details>
            <summary>{t("Clear eligible saved files")}</summary>
            <p>
              {t(
                "This app's playback stops before cleanup. Other active consumers remain protected. Your source files, exports, accounts, models, and pending saves are retained.",
              )}
            </p>
            <div className="home-links">
              {(
                [
                  "voices",
                  "originals",
                  "thumbnails",
                  "scratch",
                  "all-eligible",
                ] as const
              ).map((kind) => (
                <button
                  key={kind}
                  disabled={busy}
                  onClick={() => setTarget(kind)}
                >
                  {t(
                    {
                      voices: "Clear saved voices",
                      originals: "Clear saved originals",
                      thumbnails: "Clear artwork",
                      scratch: "Clear unused temporary files",
                      "all-eligible": "Clear all eligible cache",
                    }[kind],
                  )}
                </button>
              ))}
            </div>
          </details>
          {view.lastCleanup && (
            <p role="status">
              {t("Cleanup freed {bytes} across {count} items.", {
                bytes: bytes(view.lastCleanup.freedBytes),
                count: view.lastCleanup.removedItems,
              })}
              {view.lastCleanup.deferredItems > 0
                ? ` ${t("Some files are still in use and were retained.")}`
                : ""}
            </p>
          )}
        </>
      )}
      <button disabled={busy} onClick={() => void execute({ type: "SCAN" })}>
        {t("Check storage")}
      </button>
      {target && (
        <ModalDialog
          label={t("Confirm cache cleanup")}
          busy={busy}
          onClose={() => setTarget(undefined)}
        >
          <h3>{t("Clear eligible saved files?")}</h3>
          <p>
            {t(
              "Only unused MusicMute-owned files in the selected category will be removed. This app's playback stops first.",
            )}
          </p>
          <button
            disabled={busy}
            onClick={() => {
              void execute({
                type: "CLEANUP",
                target,
                confirmation: "clear-eligible-cache",
              });
              setTarget(undefined);
            }}
          >
            {t("Confirm cleanup")}
          </button>
          <button
            data-dialog-initial-focus
            disabled={busy}
            onClick={() => setTarget(undefined)}
          >
            {t("Keep files")}
          </button>
        </ModalDialog>
      )}
    </section>
  );
}
