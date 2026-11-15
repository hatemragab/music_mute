import type {
  FleetCommand,
  FleetEligibility,
  FleetView,
} from "../shared/fleet-contracts.js";
import type { SessionSnapshot } from "../shared/session-contracts.js";
import { WorkerAdvancedPanel } from "./worker-advanced-view.js";
import type {
  FleetAdvancedUiCommand,
  DesktopSnapshot,
} from "../shared/contracts.js";
import type { FleetAdvancedView } from "../shared/fleet-advanced-contracts.js";
import { t } from "./i18n.js";
const eligibility: Record<FleetEligibility, string> = {
  "signed-out": "Sign in with Google to register this PC.",
  "google-required": "Use Google sign-in to register a worker.",
  "recent-auth-required":
    "Sign in with Google again to confirm worker registration.",
  "approval-required": "Worker registration needs administrator approval.",
  "prepare-required": "Prepare this PC before registering its worker.",
  ready: "This PC can be registered as a worker.",
  unavailable: "Worker eligibility is unavailable. Try again when connected.",
};
const phases = {
  absent: "This PC is not enrolled.",
  stopped: "Worker stopped",
  starting: "Worker starting…",
  running: "Worker running",
  paused: "Worker paused",
  draining: "Finishing accepted jobs…",
  recovering: "Worker recovering…",
  blocked: "Worker needs attention",
};
export function WorkerPanel({
  view,
  session,
  busy,
  execute,
  signIn,
  advanced,
  following,
  selectedInput,
  executeAdvanced,
  exportReport,
  selectInput,
  benchmark,
  pickBenchmark,
  clearBenchmark,
  storeManagedUpdates = false,
}: {
  view?: FleetView;
  session?: SessionSnapshot;
  busy: boolean;
  execute(command: FleetCommand): Promise<void>;
  signIn(): void;
  advanced?: FleetAdvancedView;
  following?: boolean;
  selectedInput?: { capability: string; name: string };
  executeAdvanced?(command: FleetAdvancedUiCommand): Promise<void>;
  exportReport?(): Promise<void>;
  selectInput?(): Promise<void>;
  benchmark?: DesktopSnapshot["workerBenchmark"];
  pickBenchmark?(kind: "baseline" | "audio" | "report"): Promise<void>;
  clearBenchmark?(): Promise<void>;
  storeManagedUpdates?: boolean;
}) {
  const disabled = busy || view?.busy === true;
  const registered = view?.state === "registered";
  const intent = session?.fleet.intent ?? view?.intent;
  const phase = registered ? session?.fleet.phase : undefined;
  return (
    <section className="panel" aria-label={t("Worker")}>
      <h2>{t("Worker")}</h2>
      <p className="muted">
        {t(
          "Your worker runs while you are logged into Windows. Closing MusicMute or signing out of the app does not stop it.",
        )}
      </p>
      {view?.label && (
        <p>
          <bdi>{view.label}</bdi>
        </p>
      )}
      <p role="status">
        {view?.busy
          ? t("Updating worker state…")
          : view?.state === "revoked"
            ? t("Worker access was revoked.")
            : view?.state === "interrupted"
              ? t("Worker setup was interrupted.")
              : phase
                ? t(phases[phase])
                : registered
                  ? t("Waiting for the worker session…")
                  : t("This PC is not enrolled.")}
      </p>
      {view?.errorCode && (
        <p role="alert">
          {t(
            "Worker action needs attention. Retry or open Advanced for details.",
          )}
        </p>
      )}
      {!registered && view?.state !== "revoked" && (
        <>
          <p>{t(eligibility[view?.eligibility ?? "unavailable"])}</p>
          {view?.renewInvitationAvailable && (
            <p>
              {t(
                "Worker invitation expired. Renew it with the same Google account.",
              )}
            </p>
          )}
          {["signed-out", "google-required", "recent-auth-required"].includes(
            view?.eligibility ?? "",
          ) && (
            <button disabled={disabled} onClick={signIn}>
              {t("Open account sign-in")}
            </button>
          )}
          <div className="actions">
            <button
              disabled={disabled || !view}
              onClick={() => void execute({ type: "CHECK_ELIGIBILITY" })}
            >
              {t("Check worker eligibility")}
            </button>
            {view?.state === "interrupted" && view.renewInvitationAvailable ? (
              <button
                disabled={disabled || view.eligibility !== "ready"}
                onClick={() => void execute({ type: "RENEW_INVITATION" })}
              >
                {t("Renew worker invitation")}
              </button>
            ) : view?.state === "interrupted" ? (
              <button
                disabled={disabled}
                onClick={() => void execute({ type: "RESTORE" })}
              >
                {t("Retry worker setup")}
              </button>
            ) : (
              <button
                disabled={disabled || view?.eligibility !== "ready"}
                onClick={() => void execute({ type: "ENROLL" })}
              >
                {t("Register this PC")}
              </button>
            )}
          </div>
        </>
      )}
      {registered && (
        <div className="actions">
          {intent === "stopped" && (
            <button
              disabled={disabled || !session}
              onClick={() => void execute({ type: "START" })}
            >
              {t("Start worker")}
            </button>
          )}
          {(intent === "paused" || intent === "draining") && (
            <button
              disabled={disabled || !session}
              onClick={() => void execute({ type: "RESUME" })}
            >
              {t("Resume worker")}
            </button>
          )}
          {intent === "running" && (
            <>
              <button
                disabled={disabled || !session}
                onClick={() => void execute({ type: "PAUSE" })}
              >
                {t("Pause worker")}
              </button>
              <button
                disabled={disabled || !session}
                onClick={() => void execute({ type: "DRAIN" })}
              >
                {t("Finish jobs and pause")}
              </button>
            </>
          )}
          {intent !== "stopped" && (
            <button
              disabled={disabled || !session}
              onClick={() => void execute({ type: "STOP" })}
            >
              {t("Stop worker")}
            </button>
          )}
          <button
            disabled={disabled || !session}
            onClick={() => void execute({ type: "RESTART" })}
          >
            {t("Restart worker")}
          </button>
        </div>
      )}
      <details>
        <summary>{t("Advanced")}</summary>
        <p>
          {t(
            "Stopping and draining wait for accepted jobs to finish. They do not cancel accepted work.",
          )}
        </p>
        {session?.startup === "disabled" && (
          <p>
            {t("Windows startup is disabled. MusicMute respects that choice.")}
          </p>
        )}
        {view?.errorCode && (
          <p>
            <code>{view.errorCode}</code>
          </p>
        )}
        {session?.fleet.problem && (
          <p>
            <code>{session.fleet.problem}</code>
          </p>
        )}
        {view?.backendState && (
          <p>
            {t("Backend status at last check")}: <bdi>{view.backendState}</bdi>
          </p>
        )}
        {executeAdvanced && exportReport && selectInput ? (
          <WorkerAdvancedPanel
            storeManagedUpdates={storeManagedUpdates}
            {...(advanced ? { view: advanced } : {})}
            {...(following !== undefined ? { following } : {})}
            {...(selectedInput ? { selectedInput } : {})}
            machineId={view?.machineId ?? null}
            busy={disabled}
            execute={executeAdvanced}
            exportReport={exportReport}
            selectInput={selectInput}
            {...(benchmark ? { benchmark } : {})}
            {...(pickBenchmark ? { pickBenchmark } : {})}
            {...(clearBenchmark ? { clearBenchmark } : {})}
          />
        ) : (
          <p>{t("Advanced worker tools are unavailable.")}</p>
        )}
      </details>
    </section>
  );
}
