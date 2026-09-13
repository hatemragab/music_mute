import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProcessingPolicySummary } from "./processing-policy-summary";

describe("expanded processing policy", () => {
  it("does not turn missing worker evidence into readiness", () => {
    render(
      <ProcessingPolicySummary
        readiness={{
          evidenceStatus: "unavailable",
          expandedAdmissionAvailable: false,
          costModelRevision: null,
          maxOutstandingEstimatedWorkerSeconds: null,
        }}
      />,
    );
    expect(
      screen.getByText(/Expanded admission unavailable/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Worker-time budget: Unavailable/),
    ).toBeInTheDocument();
  });
});
