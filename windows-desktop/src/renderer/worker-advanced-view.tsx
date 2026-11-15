import { useEffect, useState } from "react";
import type {
  FleetAdvancedUiCommand,
  DesktopSnapshot,
} from "../shared/contracts.js";
import {
  parseFleetAdvancedCommand,
  type FleetAdvancedFilter,
  type FleetAdvancedMutation,
  type FleetAdvancedRead,
  type FleetAdvancedView,
} from "../shared/fleet-advanced-contracts.js";
import { ModalDialog } from "./dialog.js";
import { t } from "./i18n.js";

const sections: Record<FleetAdvancedRead, string> = {
  versions: "Versions",
  status: "Worker status",
  doctor: "Worker Doctor",
  logs: "Worker logs",
  job: "Job details",
  errors: "Recent errors",
  explain: "Explain error",
  performance: "Performance",
  capacity: "Worker capacity",
};
const actions: Record<FleetAdvancedMutation["action"], string> = {
  cleanup: "Clean eligible worker files",
  clear_logs: "Clear worker logs",
  benchmark_capacity: "Benchmark worker capacity",
  capacity: "Set worker capacity",
  benchmark_file: "Benchmark selected audio",
  revoke: "Revoke this worker",
  remove: "Remove worker from this PC",
  restore: "Restore worker on this PC",
  purge: "Clear leftover worker files",
  update: "Install worker update",
  stop: "Force stop worker",
  restart: "Force restart worker",
};
function Report({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined)
    return <span>{t("Unavailable")}</span>;
  if (typeof value !== "object")
    return (
      <bdi>
        {typeof value === "boolean" ? t(value ? "Yes" : "No") : String(value)}
      </bdi>
    );
  if (depth >= 5) return <span>{t("See full report in the export.")}</span>;
  return (
    <dl className="worker-report">
      {Object.entries(value)
        .slice(0, 100)
        .map(([key, item]) => (
          <div key={key}>
            <dt>
              <bdi>{key.replaceAll("_", " ")}</bdi>
            </dt>
            <dd>
              <Report value={item} depth={depth + 1} />
            </dd>
          </div>
        ))}
    </dl>
  );
}
export function WorkerAdvancedPanel({
  view,
  machineId,
  following = false,
  busy,
  selectedInput,
  execute,
  exportReport,
  selectInput,
  benchmark,
  pickBenchmark,
  clearBenchmark,
  storeManagedUpdates = false,
}: {
  view?: FleetAdvancedView;
  machineId?: string | null;
  following?: boolean;
  busy: boolean;
  selectedInput?: { capability: string; name: string };
  execute(command: FleetAdvancedUiCommand): Promise<void>;
  exportReport(): Promise<void>;
  selectInput(): Promise<void>;
  benchmark?: DesktopSnapshot["workerBenchmark"];
  pickBenchmark?(kind: "baseline" | "audio" | "report"): Promise<void>;
  clearBenchmark?(): Promise<void>;
  storeManagedUpdates?: boolean;
}) {
  const [section, setSection] = useState<FleetAdvancedRead>("status"),
    [lines, setLines] = useState("100"),
    [last, setLast] = useState("20"),
    [since, setSince] = useState(""),
    [level, setLevel] = useState(""),
    [jobId, setJobId] = useState(""),
    [attemptId, setAttemptId] = useState(""),
    [code, setCode] = useState(""),
    [full, setFull] = useState(false),
    [errorsOnly, setErrorsOnly] = useState(false),
    [recipe, setRecipe] = useState<"kim-vocals-v2" | "kim-vocals-v2-trim">(
      "kim-vocals-v2",
    ),
    [warmup, setWarmup] = useState("1"),
    [runs, setRuns] = useState("3"),
    [rights, setRights] = useState(false),
    [candidate, setCandidate] = useState(""),
    [useBaseline, setUseBaseline] = useState(false),
    [saveAudio, setSaveAudio] = useState(false),
    [saveReport, setSaveReport] = useState(false),
    [updateSource, setUpdateSource] = useState<"app" | "catalog">("app"),
    [forceMaintenance, setForceMaintenance] = useState(false),
    [dismissed, setDismissed] = useState<string>();
  useEffect(() => setRights(false), [selectedInput?.capability]);
  const working =
      busy || ["loading", "waiting", "running"].includes(view?.phase ?? ""),
    confirmation =
      view?.confirmation &&
      view.confirmation.token !== dismissed &&
      view.machineId === machineId
        ? view.confirmation
        : null;
  const filter: FleetAdvancedFilter = {};
  if (section === "doctor") filter.full = full;
  if (
    ["logs", "job", "errors", "explain", "performance"].includes(section) &&
    since
  )
    filter.since = since;
  if (section === "logs") {
    filter.lines = Number(lines);
    filter.errorsOnly = errorsOnly;
    filter.follow = following;
    if (level) filter.level = level as "info" | "warning" | "error";
    if (attemptId) filter.attemptId = attemptId;
  }
  if (["logs", "job", "performance"].includes(section) && jobId)
    filter.jobId = jobId;
  if (["logs", "explain"].includes(section) && code) filter.code = code;
  if (["errors", "performance"].includes(section)) filter.last = Number(last);
  if (section === "performance") filter.recipe = recipe;
  let valid = true;
  try {
    parseFleetAdvancedCommand({ type: "READ", section, filter });
  } catch {
    valid = false;
  }
  const confirm = (mutation: FleetAdvancedMutation) =>
    void execute({ type: "CONFIRM", mutation });
  const dismissConfirmation = () => {
    if (confirmation) setDismissed(confirmation.token);
    void execute({ type: "CANCEL" });
  };
  let benchmarkMutation:
    Extract<FleetAdvancedMutation, { action: "benchmark_file" }> | undefined;
  if (selectedInput && rights) {
    const mutation = {
      action: "benchmark_file" as const,
      inputCapability: selectedInput.capability,
      recipe,
      groupSize: 1 as const,
      warmupRuns: Number(warmup),
      measuredRuns: Number(runs),
      rightsConfirmed: true as const,
      ...(candidate.trim() ? { candidateRelease: candidate.trim() } : {}),
      ...(useBaseline && benchmark?.baseline
        ? { baselineCapability: benchmark.baseline.capability }
        : {}),
      ...(saveAudio && benchmark?.audioDestination
        ? {
            saveAudio: true,
            audioDestinationCapability: benchmark.audioDestination,
          }
        : {}),
      ...(saveReport && benchmark?.reportDestination
        ? { reportDestinationCapability: benchmark.reportDestination }
        : {}),
    };
    try {
      if (
        (useBaseline && !benchmark?.baseline) ||
        (saveAudio && !benchmark?.audioDestination) ||
        (saveReport && !benchmark?.reportDestination)
      )
        throw new Error("Choose benchmark files first");
      parseFleetAdvancedCommand({ type: "CONFIRM", mutation });
      benchmarkMutation = mutation;
    } catch {
      /* Invalid optional choices cannot authorize a benchmark. */
    }
  }
  return (
    <section aria-label={t("Worker Advanced")}>
      <h3>{t("Worker Advanced")}</h3>
      <p>
        {t(
          "Reports stay local. Regular maintenance waits for accepted jobs and protected files.",
        )}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) void execute({ type: "READ", section, filter });
        }}
      >
        <label>
          {t("Report")}
          <select
            value={section}
            disabled={working}
            onChange={(event) =>
              setSection(event.target.value as FleetAdvancedRead)
            }
          >
            {Object.entries(sections).map(([key, title]) => (
              <option key={key} value={key}>
                {t(title)}
              </option>
            ))}
          </select>
        </label>
        {section === "doctor" && (
          <label>
            <input
              type="checkbox"
              checked={full}
              onChange={(event) => setFull(event.target.checked)}
            />
            {t("Run full integrity checks")}
          </label>
        )}
        {["logs", "job", "errors", "explain", "performance"].includes(
          section,
        ) && (
          <label>
            {t("Since (for example 1h)")}
            <input
              value={since}
              onChange={(event) => setSince(event.target.value)}
              maxLength={8}
            />
          </label>
        )}
        {["logs", "job", "performance"].includes(section) && (
          <label>
            {t("Job ID")}
            <input
              dir="ltr"
              value={jobId}
              onChange={(event) => setJobId(event.target.value)}
              maxLength={24}
            />
          </label>
        )}
        {["logs", "explain"].includes(section) && (
          <label>
            {t("Error code")}
            <input
              dir="ltr"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              maxLength={100}
            />
          </label>
        )}
        {section === "logs" && (
          <>
            <label>
              {t("Log lines")}
              <input
                type="number"
                min="1"
                max="1000"
                value={lines}
                onChange={(event) => setLines(event.target.value)}
              />
            </label>
            <label>
              {t("Log level")}
              <select
                value={level}
                onChange={(event) => setLevel(event.target.value)}
              >
                <option value="">{t("All")}</option>
                {["info", "warning", "error"].map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
            <label>
              {t("Attempt ID")}
              <input
                dir="ltr"
                value={attemptId}
                onChange={(event) => setAttemptId(event.target.value)}
                maxLength={36}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={errorsOnly}
                onChange={(event) => setErrorsOnly(event.target.checked)}
              />
              {t("Errors only")}
            </label>
            <label>
              <input
                type="checkbox"
                disabled={working || !valid}
                checked={following}
                onChange={(event) =>
                  void execute({
                    type: "READ",
                    section: "logs",
                    filter: { ...filter, follow: event.target.checked },
                  })
                }
              />
              {t("Follow local logs")}
            </label>
          </>
        )}
        {["errors", "performance"].includes(section) && (
          <label>
            {t("Recent entries")}
            <input
              type="number"
              min="1"
              max="100"
              value={last}
              onChange={(event) => setLast(event.target.value)}
            />
          </label>
        )}
        {section === "performance" && (
          <label>
            {t("Recipe")}
            <select
              value={recipe}
              onChange={(event) =>
                setRecipe(event.target.value as typeof recipe)
              }
            >
              <option value="kim-vocals-v2">{t("Full voice")}</option>
              <option value="kim-vocals-v2-trim">{t("Trimmed voice")}</option>
            </select>
          </label>
        )}
        {!valid && (
          <p role="status">{t("Enter valid report filters before reading.")}</p>
        )}
        <button disabled={working || !valid} type="submit">
          {t("Read report")}
        </button>
      </form>
      <p role="status">
        {working
          ? t("Worker action in progress…")
          : view?.phase === "recovery"
            ? t("Worker action needs recovery.")
            : t("Worker reports are ready to inspect.")}
      </p>
      {view?.problem && (
        <p role="alert">
          <code>{view.problem}</code>
        </p>
      )}
      {view?.data != null && <Report value={view.data} />}
      {storeManagedUpdates ? (
        <p role="status">
          {t("Microsoft Store manages app and worker updates.")}
        </p>
      ) : (
        <label>
          {t("Worker update source")}
          <select
            value={updateSource}
            disabled={working}
            onChange={(event) =>
              setUpdateSource(event.target.value as "app" | "catalog")
            }
          >
            <option value="app">{t("Managed by this app")}</option>
            <option value="catalog">{t("Signed worker catalog")}</option>
          </select>
        </label>
      )}
      <div className="actions">
        <button
          disabled={working || view?.data == null}
          onClick={() => void exportReport()}
        >
          {t("Export worker report")}
        </button>
        <button
          disabled={working}
          onClick={() => void execute({ type: "CLEANUP_PREVIEW" })}
        >
          {t("Preview cleanup")}
        </button>
        <button
          disabled={working}
          onClick={() =>
            void execute({
              type: "UPDATE_CHECK",
              ...(!storeManagedUpdates && updateSource === "catalog"
                ? { source: updateSource }
                : {}),
            })
          }
        >
          {t("Check worker updates")}
        </button>
        <button
          disabled={working}
          onClick={() => void execute({ type: "RECOVER" })}
        >
          {t("Recover worker action")}
        </button>
        {view?.cancellable && (
          <button onClick={() => void execute({ type: "CANCEL" })}>
            {t("Cancel worker action")}
          </button>
        )}
      </div>
      <details>
        <summary>{t("Maintenance and capacity")}</summary>
        <label className="check-row">
          <input
            type="checkbox"
            checked={forceMaintenance}
            disabled={working}
            onChange={(event) => setForceMaintenance(event.target.checked)}
          />
          {t(
            storeManagedUpdates
              ? "Interrupt accepted jobs for revocation"
              : "Interrupt accepted jobs for updates or revocation",
          )}
        </label>
        <div className="actions">
          {(
            [
              "cleanup",
              "clear_logs",
              "benchmark_capacity",
              "revoke",
              "remove",
              "restore",
              "purge",
              "update",
            ] as const
          ).map((action) => (
            <button
              key={action}
              disabled={working || !machineId}
              onClick={() =>
                confirm(
                  action === "update"
                    ? {
                        action,
                        ...(!storeManagedUpdates && updateSource === "catalog"
                          ? { source: updateSource }
                          : {}),
                        ...(!storeManagedUpdates && forceMaintenance
                          ? { force: true }
                          : {}),
                      }
                    : action === "revoke"
                      ? {
                          action,
                          ...(forceMaintenance ? { force: true } : {}),
                        }
                      : { action },
                )
              }
            >
              {t(
                storeManagedUpdates && action === "update"
                  ? "Open MusicMute Worker in Microsoft Store"
                  : actions[action],
              )}
            </button>
          ))}
          {(["stop", "restart"] as const).map((action) => (
            <button
              key={action}
              disabled={working || !machineId}
              onClick={() => confirm({ action, force: true })}
            >
              {t(actions[action])}
            </button>
          ))}
          {[1, 2].map((workers) => (
            <button
              key={workers}
              disabled={working || !machineId}
              onClick={() =>
                confirm({ action: "capacity", workers: workers as 1 | 2 })
              }
            >
              {t("Request {count} worker(s)", { count: workers })}
            </button>
          ))}
        </div>
        <p>{t("Measured capacity still requires backend approval.")}</p>
      </details>
      <details>
        <summary>{t("Benchmark selected audio")}</summary>
        <button disabled={working} onClick={() => void selectInput()}>
          {t("Choose benchmark audio")}
        </button>
        {selectedInput && (
          <p>
            <bdi>{selectedInput.name}</bdi>
          </p>
        )}
        <label>
          {t("Group size")}
          <select value="1" disabled>
            <option value="1">1</option>
          </select>
        </label>
        <label>
          {t("Candidate runtime release")}
          <input
            disabled={working}
            value={candidate}
            placeholder={t("Use the current approved runtime")}
            onChange={(event) => setCandidate(event.target.value)}
          />
        </label>
        <p className="muted">
          {t("A candidate must already be installed and signed for this PC.")}
        </p>
        <label className="check-row">
          <input
            type="checkbox"
            disabled={working}
            checked={useBaseline}
            onChange={(event) => setUseBaseline(event.target.checked)}
          />
          {t("Compare with a saved baseline")}
        </label>
        {useBaseline && (
          <>
            <button
              disabled={working || !pickBenchmark}
              onClick={() => void pickBenchmark?.("baseline")}
            >
              {t("Choose baseline report")}
            </button>
            {benchmark?.baseline && (
              <p>
                <bdi>{benchmark.baseline.name}</bdi>
              </p>
            )}
          </>
        )}
        <label className="check-row">
          <input
            type="checkbox"
            disabled={working}
            checked={saveAudio}
            onChange={(event) => setSaveAudio(event.target.checked)}
          />
          {t("Save benchmark audio")}
        </label>
        {saveAudio && (
          <button
            disabled={working || !pickBenchmark}
            onClick={() => void pickBenchmark?.("audio")}
          >
            {t(
              benchmark?.audioDestination
                ? "Change audio destination"
                : "Choose audio destination",
            )}
          </button>
        )}
        <label className="check-row">
          <input
            type="checkbox"
            disabled={working}
            checked={saveReport}
            onChange={(event) => setSaveReport(event.target.checked)}
          />
          {t("Save benchmark report")}
        </label>
        {saveReport && (
          <button
            disabled={working || !pickBenchmark}
            onClick={() => void pickBenchmark?.("report")}
          >
            {t(
              benchmark?.reportDestination
                ? "Change report destination"
                : "Choose report destination",
            )}
          </button>
        )}
        {clearBenchmark && (
          <button disabled={working} onClick={() => void clearBenchmark()}>
            {t("Clear benchmark file choices")}
          </button>
        )}
        <label>
          {t("Recipe")}
          <select
            value={recipe}
            onChange={(event) => setRecipe(event.target.value as typeof recipe)}
          >
            <option value="kim-vocals-v2">{t("Full voice")}</option>
            <option value="kim-vocals-v2-trim">{t("Trimmed voice")}</option>
          </select>
        </label>
        <label>
          {t("Warmup runs")}
          <input
            type="number"
            min="0"
            max="2"
            value={warmup}
            onChange={(event) => setWarmup(event.target.value)}
          />
        </label>
        <label>
          {t("Measured runs")}
          <input
            type="number"
            min="3"
            max="10"
            value={runs}
            onChange={(event) => setRuns(event.target.value)}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={rights}
            onChange={(event) => setRights(event.target.checked)}
          />
          {t("I have permission to process this audio.")}
        </label>
        <button
          disabled={working || !machineId || !benchmarkMutation}
          onClick={() => benchmarkMutation && confirm(benchmarkMutation)}
        >
          {t("Prepare benchmark confirmation")}
        </button>
      </details>
      {confirmation && (
        <ModalDialog
          label={t("Confirm worker action")}
          busy={working}
          onClose={dismissConfirmation}
        >
          <h3>
            {t(
              storeManagedUpdates && confirmation.action === "update"
                ? "Open MusicMute Worker in Microsoft Store"
                : actions[confirmation.action],
            )}
          </h3>
          <p>
            {t(
              "This confirmation applies to the current worker only. Changed worker state requires a new confirmation.",
            )}
          </p>
          <p>
            {t(
              storeManagedUpdates && confirmation.action === "update"
                ? "Microsoft Store manages app and worker updates."
                : confirmation.force === true ||
                    confirmation.action === "stop" ||
                    confirmation.action === "restart"
                  ? "Accepted worker jobs will be interrupted. Protected files and other active work must finish."
                  : "Accepted jobs and protected files must finish before maintenance.",
            )}
          </p>
          {confirmation.action === "update" && !storeManagedUpdates && (
            <p>
              {t("Update source: {source}", {
                source: t(
                  confirmation.source === "catalog"
                    ? "Signed worker catalog"
                    : "Managed by this app",
                ),
              })}
            </p>
          )}
          <button
            disabled={working}
            onClick={() => {
              setDismissed(confirmation.token);
              void execute({ type: "RUN", confirmation: confirmation.token });
            }}
          >
            {t("Confirm worker action")}
          </button>
          <button
            data-dialog-initial-focus
            disabled={working}
            onClick={dismissConfirmation}
          >
            {t("Keep current state")}
          </button>
        </ModalDialog>
      )}
    </section>
  );
}
