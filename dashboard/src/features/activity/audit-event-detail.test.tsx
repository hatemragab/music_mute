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
        action: "account_policy_override.updated",
        resourceType: "account_policy_override",
        resourceId: "user-fixture",
        operationId: "operation-fixture",
        reason: "Reviewed account exception",
        at: "2026-09-13T12:00:00Z",
        previousRevision: 1,
        nextRevision: 2,
        outcome: "succeeded",
        processingChanges: [
          { field: "monthlyProcessingSeconds", before: 3600, after: 7200 },
          {
            field: "overrideExpiresAt",
            before: null,
            after: "2026-09-14T12:00:00Z",
          },
        ],
      }}
    />,
  );
  expect(screen.getByText("owner-fixture")).toBeInTheDocument();
  expect(screen.getByText("Reviewed account exception")).toBeInTheDocument();
  expect(screen.getByText(/3600 → 7200/)).toBeInTheDocument();
  expect(screen.getByText(/None → 2026-09-14/)).toBeInTheDocument();
});
