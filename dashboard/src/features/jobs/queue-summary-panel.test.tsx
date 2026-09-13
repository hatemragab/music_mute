import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueueSummaryPanel } from "./queue-summary-panel";

describe("queue workload", () => {
  it("hides stale estimated values and does not turn them into zero", () => {
    render(
      <QueueSummaryPanel
        summary={{
          outstandingJobs: 0,
          outstandingAudioSeconds: 0,
          queuedJobs: 0,
          queuedAudioSeconds: 0,
          oldestQueuedAt: null,
          limits: {
            maxOutstandingJobs: 100,
            maxOutstandingAudioSeconds: 60000,
          },
          estimatedWorkerSeconds: 9000,
          estimatedWaitRange: { minSeconds: 60, maxSeconds: 120 },
          evidenceStatus: "verified",
          checkedAt: "2000-01-01T00:00:00Z",
        }}
      />,
    );
    expect(screen.getByText(/Snapshot stale/)).toBeInTheDocument();
    expect(screen.getAllByText("Unavailable")).toHaveLength(2);
    expect(screen.queryByText("150 min")).not.toBeInTheDocument();
  });
  it("shows audio minutes, distinct reservation count, and unknown estimates", () => {
    render(
      <QueueSummaryPanel
        summary={{
          distribution: {
            short: { jobs: 2, audioSeconds: 120 },
            long: { jobs: 1, audioSeconds: 1800 },
          },
          shortLongThresholdSeconds: 600,
          outstandingJobs: 3,
          outstandingAudioSeconds: 1920,
          queuedJobs: 2,
          queuedAudioSeconds: 1860,
          oldestQueuedAt: null,
          limits: {
            maxOutstandingJobs: 100,
            maxOutstandingAudioSeconds: 60000,
          },
          estimatedWorkerSeconds: null,
          estimatedWaitRange: null,
          evidenceStatus: "unavailable",
          checkedAt: "2026-09-13T12:00:00Z",
        }}
      />,
    );
    expect(
      screen.getByText(
        /2 jobs \/ 2 min at or below 10 min; 1 jobs \/ 30 min above it/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("31 min")).toBeInTheDocument();
    expect(screen.getByText("32 min")).toBeInTheDocument();
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
    expect(screen.getByText(/Cancellation stays pending/)).toBeInTheDocument();
  });
});
