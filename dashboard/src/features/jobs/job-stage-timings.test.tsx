import { formatDuration } from "@/lib/format";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { JobStageTimings } from "./job-stage-timings";
import { formatStageDuration } from "./job-timing-format";

describe("server stage timing presentation", () => {
  it("renders measured zero, partial stages and the server total without inventing skipped stages", () => {
    render(
      <JobStageTimings
        timings={{
          totalMs: 12500,
          totalComplete: false,
          stages: [
            { stage: "queue", durationMs: 0, complete: true },
            { stage: "separation", durationMs: 9000, complete: false },
          ],
        }}
      />,
    );
    expect(screen.getByText("0 ms")).toBeInTheDocument();
    expect(screen.getByText("At least 9 s")).toBeInTheDocument();
    expect(screen.getByText("At least 12.5 s")).toBeInTheDocument();
    expect(screen.getByText("Music removal")).toBeInTheDocument();
    expect(screen.queryByText("Result upload")).not.toBeInTheDocument();
  });

  it("uses precise readable units without rounding short stages to zero", () => {
    expect(formatStageDuration(4)).toBe("4 ms");
    expect(formatStageDuration(4321)).toBe("4.32 s");
    expect(formatStageDuration(59999)).toBe("60 s");
    expect(formatStageDuration(61000)).toBe("1m 01s");
    expect(formatDuration(119.9)).toBe("2m 0s");
    expect(formatStageDuration(null)).toBe("Not recorded");
    expect(formatStageDuration(-1)).toBe("Not recorded");
  });

  it("shows saved engine measurements on historical jobs without inventing lifecycle timings", () => {
    render(
      <JobStageTimings
        timings={null}
        workerTimings={[
          { stage: "separation", durationMs: 42345 },
          { stage: "encode", durationMs: 348 },
        ]}
      />,
    );
    expect(screen.getByText("Saved worker measurements")).toBeInTheDocument();
    expect(screen.getByText("42.34 s")).toBeInTheDocument();
    expect(screen.getByText("348 ms")).toBeInTheDocument();
    expect(screen.queryByText("Worker queue")).not.toBeInTheDocument();
  });

  it("keeps attempt measurements separate from aggregate durations", () => {
    render(
      <JobStageTimings
        timings={{
          totalMs: 4000,
          totalComplete: true,
          stages: [{ stage: "separation", durationMs: 3000, complete: false }],
          attempts: [
            {
              attemptNumber: 1,
              stages: [
                { stage: "separation", durationMs: 1000, complete: false },
              ],
            },
            {
              attemptNumber: 2,
              stages: [
                { stage: "separation", durationMs: 2000, complete: true },
              ],
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("Timing by attempt (2)")).toBeInTheDocument();
    expect(screen.getByText("At least 3 s")).toBeInTheDocument();
    expect(screen.getByText("Attempt 1")).toBeInTheDocument();
    expect(screen.getByText("Attempt 2")).toBeInTheDocument();
  });

  it("shows historical timing as unavailable", () => {
    render(<JobStageTimings timings={null} />);
    expect(
      screen.getByText(
        "Full stage measurements were not recorded for this job. Missing durations cannot be reconstructed accurately.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("0 ms")).not.toBeInTheDocument();
  });
});
