import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProcessingUsage } from "@/api/contracts";
import { createOperationId } from "@/api/api-client";
import { useAdminSession, useApiClient } from "@/auth/admin-session";
import { ErrorState, LoadingState, PageSection } from "@/components/page";
import { ReasonDialog } from "@/components/reason-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import {
  getProcessingUsage,
  setProcessingAllowance,
  clearProcessingAllowance,
} from "./users-api";
import { ProcessingAllowanceDialog } from "./processing-allowance-dialog";

const minutes = (value: number) =>
  `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value / 60)} min`;
export function ProcessingUsagePanel({ usage }: { usage: ProcessingUsage }) {
  return (
    <div className="space-y-4">
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ["Used audio", minutes(usage.usedAudioSeconds)],
          ["Reserved audio", minutes(usage.reservedAudioSeconds)],
          ["Remaining allowance", minutes(usage.remainingAudioSeconds)],
          ["Unfinished jobs", `${usage.activeJobs} / ${usage.maxActiveJobs}`],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 font-mono text-lg">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm">
        Availability: {usage.availability} · Rolling allowance:{" "}
        {minutes(usage.allowanceAudioSeconds)}
      </p>
      <p className="text-sm">
        Next replenishment:{" "}
        {usage.nextReplenishmentAt
          ? formatDateTime(usage.nextReplenishmentAt)
          : "Unavailable"}
      </p>
      {usage.replenishments.length ? (
        <ul className="space-y-1 text-sm">
          {usage.replenishments.map((entry, index) => (
            <li key={`${entry.at}-${index}`}>
              {formatDateTime(entry.at)}: {minutes(entry.audioSeconds)}
            </li>
          ))}
        </ul>
      ) : null}
      {usage.allowanceOverride ? (
        <p className="rounded-lg border p-3 text-sm">
          Temporary total allowance:{" "}
          {minutes(usage.allowanceOverride.allowanceAudioSeconds)} · Expires{" "}
          {formatDateTime(usage.allowanceOverride.expiresAt)}. Effective access
          is confirmed by the server.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          No temporary allowance override.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Checked {formatDateTime(usage.checkedAt)} · Policy revision{" "}
        {usage.policyRevision} · Account revision {usage.revision}
      </p>
      <p className="text-sm text-muted-foreground">
        Unfinished and unresolved cancellation holds remain reserved until
        authoritative settlement. A rolling window has multiple replenishments;
        deleting history does not restore allowance.
      </p>
    </div>
  );
}

export function ProcessingUsageSection({ userId }: { userId: string }) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { can, reauthenticate } = useAdminSession();
  const usage = useQuery({
    queryKey: ["processing-usage", userId],
    queryFn: () => getProcessingUsage(client, userId),
    enabled: can("users.read"),
  });
  const [editingRevision, setEditingRevision] = useState<number | null>(null);
  const [clearingRevision, setClearingRevision] = useState<number | null>(null);
  const update = useMutation({
    mutationFn: (input: {
      allowanceAudioSeconds: number;
      expiresAt: string;
      reason: string;
    }) => {
      if (!can("users.processing.manage") || editingRevision == null)
        throw new Error(
          "Permission and a current account revision are required.",
        );
      return setProcessingAllowance(client, userId, {
        ...input,
        operationId: createOperationId(),
        expectedRevision: editingRevision,
      });
    },
    onSuccess: async (result) => {
      queryClient.setQueryData(["processing-usage", userId], result);
      await queryClient.invalidateQueries({ queryKey: ["user", userId] });
      await queryClient.invalidateQueries({ queryKey: ["users"] });
      await queryClient.invalidateQueries({ queryKey: ["audit"] });
    },
  });
  const clear = async (reason: string) => {
    if (!can("users.processing.manage") || clearingRevision == null)
      throw new Error(
        "Permission and a current account revision are required.",
      );
    const result = await clearProcessingAllowance(client, userId, {
      operationId: createOperationId(),
      expectedRevision: clearingRevision,
      reason,
    });
    queryClient.setQueryData(["processing-usage", userId], result);
    await queryClient.invalidateQueries({ queryKey: ["user", userId] });
    await queryClient.invalidateQueries({ queryKey: ["audit"] });
  };
  if (!can("users.read")) return null;
  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <PageSection title="Rolling processing allowance">
          {usage.isLoading ? (
            <LoadingState />
          ) : usage.isError ? (
            <ErrorState
              error={usage.error}
              retry={() => void usage.refetch()}
            />
          ) : usage.data ? (
            <>
              <ProcessingUsagePanel usage={usage.data} />
              <div className="mt-4 flex flex-wrap gap-3">
                <Button variant="outline" onClick={() => void usage.refetch()}>
                  Refresh usage
                </Button>
                {can("users.processing.manage") ? (
                  <>
                    <Button
                      onClick={() => setEditingRevision(usage.data!.revision)}
                    >
                      Temporary allowance increase
                    </Button>
                    {usage.data.allowanceOverride ? (
                      <Button
                        variant="outline"
                        onClick={() =>
                          setClearingRevision(usage.data!.revision)
                        }
                      >
                        Revoke allowance override
                      </Button>
                    ) : null}
                  </>
                ) : null}
              </div>
              <ProcessingAllowanceDialog
                open={editingRevision != null}
                onOpenChange={(open) => {
                  if (!open) setEditingRevision(null);
                }}
                currentSeconds={usage.data.allowanceAudioSeconds}
                reauthenticate={reauthenticate}
                onSave={(input) =>
                  update.mutateAsync(input).then(() => undefined)
                }
              />
              <ReasonDialog
                open={clearingRevision != null}
                onOpenChange={(open) => {
                  if (!open) setClearingRevision(null);
                }}
                title="Revoke allowance override"
                description="Return to the regular rolling allowance. Already accepted reservations remain held and media safety limits are unchanged."
                confirmLabel="Revoke override"
                destructive
                freshAuth
                onReauthenticate={reauthenticate}
                onConfirm={clear}
              />
            </>
          ) : null}
        </PageSection>
      </CardContent>
    </Card>
  );
}
