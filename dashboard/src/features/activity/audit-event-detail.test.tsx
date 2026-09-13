import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { AuditEventDetail } from "./audit-event-detail";

it("shows only server-provided processing changes with actor and reason", () => {
  render(
    <AuditEventDetail
      onClose={() => undefined}
      event={{
        id: "audit",
        actorUid: "owner-fixture",
        action: "processing_allowance_updated",
        resourceType: "user",
        resourceId: "user-fixture",
        operationId: "operation-fixture",
        reason: "Temporary reviewed increase",
        at: "2026-09-13T12:00:00Z",
        previousRevision: 1,
        nextRevision: 2,
        outcome: "succeeded",
        processingChanges: [
          { field: "allowanceAudioSeconds", before: 3600, after: 7200 },
          {
            field: "allowanceExpiresAt",
            before: null,
            after: "2026-09-14T12:00:00Z",
          },
        ],
      }}
    />,
  );
  expect(screen.getByText("owner-fixture")).toBeInTheDocument();
  expect(screen.getByText("Temporary reviewed increase")).toBeInTheDocument();
  expect(screen.getByText(/3600 → 7200/)).toBeInTheDocument();
  expect(screen.getByText(/None → 2026-09-14/)).toBeInTheDocument();
});
