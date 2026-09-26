import type { JobDetail } from "@/api/contracts";
import { formatDuration } from "@/lib/format";

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
};

export function JobStageTimings({
  timings,
}: {
  timings: JobDetail["serverStageTimings"];
}) {
  return (
    <>
      {timings ? (
        <>
          <p className="mb-3 text-sm text-muted-foreground">
            Server measurements across all attempts. Partial durations are the
            last recorded measurements.
          </p>
          <ul className="space-y-3">
            {timings.stages.map((stage) => (
              <li
                key={stage.stage}
                className="grid grid-cols-[1fr_auto] gap-3 border-b pb-2 text-sm"
              >
                <span>{timingLabels[stage.stage] ?? "Other processing"}</span>
                <span className="font-mono text-muted-foreground">
                  {stage.complete ? "" : "At least "}
                  {formatDuration(stage.durationMs / 1000)}
                </span>
              </li>
            ))}
            <li className="flex justify-between gap-3 font-medium">
              <span>Server total</span>
              <span>
                {timings.totalComplete || timings.totalMs == null
                  ? ""
                  : "At least "}
                {formatDuration(
                  timings.totalMs == null ? null : timings.totalMs / 1000,
                )}
              </span>
            </li>
          </ul>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Server stage measurements are unavailable for this job.
        </p>
      )}
    </>
  );
}
