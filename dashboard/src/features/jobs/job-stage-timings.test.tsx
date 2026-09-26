import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { JobStageTimings } from "./job-stage-timings";

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
    expect(screen.getByText("0.0s")).toBeInTheDocument();
    expect(screen.getByText("At least 9.0s")).toBeInTheDocument();
    expect(screen.getByText("At least 13s")).toBeInTheDocument();
    expect(screen.getByText("Music removal")).toBeInTheDocument();
    expect(screen.queryByText("Result upload")).not.toBeInTheDocument();
  });

  it("shows historical timing as unavailable", () => {
    render(<JobStageTimings timings={null} />);
    expect(
      screen.getByText(
        "Server stage measurements are unavailable for this job.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("0.0s")).not.toBeInTheDocument();
  });
});
