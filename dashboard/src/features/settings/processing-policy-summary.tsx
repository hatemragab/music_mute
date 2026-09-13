import type { ProcessingReadiness } from "@/api/contracts";

export function ProcessingPolicySummary({
  readiness,
}: {
  readiness: ProcessingReadiness;
}) {
  return (
    <div className="space-y-2 rounded-xl border bg-muted/20 p-4 text-sm">
      <p className="font-medium">
        {readiness.expandedAdmissionAvailable
          ? "Expanded admission has verified worker capacity"
          : "Expanded admission unavailable — worker qualification is required"}
      </p>
      <p>
        Evidence: {readiness.evidenceStatus}. Cost model:{" "}
        {readiness.costModelRevision ?? "Unavailable"}.
      </p>
      <p>
        Worker-time budget:{" "}
        {readiness.maxOutstandingEstimatedWorkerSeconds == null
          ? "Unavailable"
          : `${readiness.maxOutstandingEstimatedWorkerSeconds} estimated seconds`}
      </p>
      <p>
        Capable workers:{" "}
        {readiness.capableWorkerIds?.join(", ") || "Unavailable"}
      </p>
      <p className="text-muted-foreground">
        Source size, prepared audio bytes, audio duration, estimated worker time
        and actual execution are separate quantities. Configured limits never
        authorize extra worker slots. Accepted jobs retain their admission
        snapshots.
      </p>
    </div>
  );
}
