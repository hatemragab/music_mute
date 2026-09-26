import { formatStageDuration } from "./job-timing-format";
import type { JobDetail } from "@/api/contracts";

const timingLabels: Record<string, string> = {
  "import-queue": "Source queue",
  "source-download": "Source download",
  "source-validation": "Source validation",
  "source-upload": "Source upload",
  "upload-confirmation": "Upload confirmation",
  "submission-window": "Submission and confirmation",
  queue: "Worker queue",
  "retry-wait": "Retry wait",
  "resource-check": "Worker setup",
  "input-download": "Worker download",
  "input-validation": "Input validation",
  preparation: "Audio preparation",
  "model-load": "Model loading",
  separation: "Music removal",
  denoise: "Noise removal",
  trim: "Silence trimming",
  encoding: "Audio encoding",
  "output-validation": "Result validation",
  "output-ready": "Result preparation",
  "output-upload": "Result upload",
  completion: "Server finalization",
  modelValidation: "Model validation",
  inputIdentity: "Input integrity check",
  mediaValidation: "Media validation",
  modelLoad: "Model loading",
  encode: "Audio encoding",
  outputValidation: "Result validation",
};

type Measurement = { stage: string; durationMs: number; complete: boolean };

function StageRows({ stages }: { stages: Measurement[] }) {
  return (
    <dl className="divide-y">
      {stages.map((stage) => (
        <div
          key={stage.stage}
          className="flex items-center justify-between gap-4 py-3 text-sm"
        >
          <dt>
            {timingLabels[stage.stage] ?? stage.stage.replaceAll("-", " ")}
          </dt>
          <dd className="shrink-0 text-right">
            <span className="font-mono font-semibold tabular-nums">
              {stage.complete ? "" : "At least "}
              {formatStageDuration(stage.durationMs)}
            </span>
            {!stage.complete && (
              <span className="block text-xs text-muted-foreground">
                Partial measurement
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function JobStageTimings({
  timings,
  workerTimings = [],
}: {
  timings: JobDetail["serverStageTimings"];
  workerTimings?: JobDetail["workerStageTimings"];
}) {
  const hasExecutionMeasurements = timings?.stages.some((s) =>
    [
      "input-validation",
      "preparation",
      "model-load",
      "separation",
      "encoding",
      "output-upload",
    ].includes(s.stage),
  );
  const showSavedEngine = workerTimings.length > 0 && !hasExecutionMeasurements;
  return (
    <div className="space-y-4">
      {timings ? (
        <>
          <div className="rounded-lg border bg-muted/30 p-4">
            <p className="text-sm text-muted-foreground">
              Total time on the server
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {timings.totalMs != null && !timings.totalComplete
                ? "At least "
                : ""}
              {formatStageDuration(timings.totalMs)}
            </p>
          </div>
          <p className="text-sm text-muted-foreground">
            Measured by the server and worker, across all attempts. Partial
            values show the last recorded duration. The total also includes
            coordination time.
          </p>
          <StageRows stages={timings.stages} />
          {(timings.attempts?.length ?? 0) > 1 && (
            <details className="rounded-lg border p-3">
              <summary className="cursor-pointer text-sm font-medium">
                Timing by attempt ({timings.attempts!.length})
              </summary>
              {timings.attempts!.map((attempt) => (
                <section key={attempt.attemptNumber} className="mt-4">
                  <h3 className="text-sm font-semibold">
                    Attempt {attempt.attemptNumber}
                  </h3>
                  <StageRows stages={attempt.stages} />
                </section>
              ))}
            </details>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Full stage measurements were not recorded for this job. Missing
          durations cannot be reconstructed accurately.
        </p>
      )}
      {showSavedEngine && (
        <section>
          <h3 className="text-sm font-semibold">Saved worker measurements</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Successful attempt only. Queue and transfer time are not included.
          </p>
          <StageRows
            stages={workerTimings.map((stage) => ({
              ...stage,
              complete: true,
            }))}
          />
        </section>
      )}
      {timings && !hasExecutionMeasurements && !showSavedEngine && (
        <p className="text-sm text-muted-foreground">
          Worker stage durations have not been reported.
        </p>
      )}
    </div>
  );
}
