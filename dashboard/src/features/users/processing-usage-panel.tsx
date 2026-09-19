import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AccountUsage } from "@/api/contracts";
import { createOperationId } from "@/api/api-client";
import { useAdminSession, useApiClient } from "@/auth/admin-session";
import { ErrorState, LoadingState, PageSection } from "@/components/page";
import { ReasonDialog } from "@/components/reason-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import {
  clearAccountPolicyOverride,
  getAccountUsage,
  setAccountPolicyOverride,
} from "./users-api";
import { AccountPolicyOverrideDialog } from "./account-policy-override-dialog";

const minutes = (value: number) =>
  `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value / 60)} min`;

export function ProcessingUsagePanel({ usage }: { usage: AccountUsage }) {
  const processing = usage.processing;
  return (
    <div className="space-y-4">
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {[
          ["Monthly limit", minutes(processing.limitSeconds)],
          ["Used", minutes(processing.usedSeconds)],
          ["Reserved", minutes(processing.reservedSeconds)],
          ["Refunded / released", minutes(processing.releasedSeconds)],
          ["Remaining", minutes(processing.remainingSeconds)],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 font-mono text-lg">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm">
        UTC period {usage.period.key}: {formatDateTime(usage.period.start)} →{" "}
        {formatDateTime(usage.period.end)}. Next reset{" "}
        {formatDateTime(usage.period.nextResetAt)}.
      </p>
      <p className="text-sm">
        Policy source: {usage.effectivePolicySource.replaceAll("_", " ")} ·{" "}
        availability {usage.availability.status}
        {usage.availability.reason
          ? ` (${usage.availability.reason.replaceAll("_", " ")})`
          : ""}
        .
      </p>
      {usage.policyOverride ? (
        <p className="rounded-lg border p-3 text-sm">
          Account override revision {usage.policyOverride.revision}:{" "}
          {minutes(
            usage.policyOverride.values.monthlyProcessingSeconds ??
              processing.limitSeconds,
          )}
          {usage.policyOverride.expiresAt
            ? ` · Expires ${formatDateTime(usage.policyOverride.expiresAt)}`
            : " · No expiry"}
          .
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          No account policy override. The global standard policy applies.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Checked {formatDateTime(usage.checkedAt)} · policy revision{" "}
        {usage.policyRevision} · usage revision {usage.usageRevision}. Active
        jobs {usage.activeJobs} / {usage.maxProcessingJobs}.
      </p>
      <p className="text-sm text-muted-foreground">
        Usage belongs to the account and is shared by all installations. Devices
        do not split or renew this allowance.
      </p>
    </div>
  );
}

export function ProcessingUsageSection({ userId }: { userId: string }) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { can, reauthenticate } = useAdminSession();
  const usage = useQuery({
    queryKey: ["account-usage", userId],
    queryFn: () => getAccountUsage(client, userId),
    enabled: can("users.read"),
  });
  const [editingRevision, setEditingRevision] = useState<number | null>(null);
  const [clearingRevision, setClearingRevision] = useState<number | null>(null);
  const update = useMutation({
    mutationFn: (input: {
      monthlyProcessingSeconds: number;
      expiresAt: string | null;
      reason: string;
    }) => {
      if (!can("users.processing.manage") || editingRevision == null)
        throw new Error(
          "Permission and a current override revision are required.",
        );
      return setAccountPolicyOverride(client, userId, {
        values: {
          monthlyProcessingSeconds: input.monthlyProcessingSeconds,
        },
        expiresAt: input.expiresAt,
        reason: input.reason,
        operationId: createOperationId(),
        expectedRevision: editingRevision,
      });
    },
    onSuccess: async (result) => {
      queryClient.setQueryData(["account-usage", userId], result);
      await queryClient.invalidateQueries({ queryKey: ["user", userId] });
      await queryClient.invalidateQueries({ queryKey: ["users"] });
      await queryClient.invalidateQueries({ queryKey: ["audit"] });
    },
  });
  const clear = async (reason: string) => {
    if (!can("users.processing.manage") || clearingRevision == null)
      throw new Error(
        "Permission and a current override revision are required.",
      );
    const result = await clearAccountPolicyOverride(client, userId, {
      operationId: createOperationId(),
      expectedRevision: clearingRevision,
      reason,
    });
    queryClient.setQueryData(["account-usage", userId], result);
    await queryClient.invalidateQueries({ queryKey: ["user", userId] });
    await queryClient.invalidateQueries({ queryKey: ["audit"] });
  };
  if (!can("users.read")) return null;
  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <PageSection title="UTC monthly account usage">
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
                      onClick={() =>
                        setEditingRevision(
                          usage.data!.policyOverride?.revision ?? 0,
                        )
                      }
                    >
                      {usage.data.policyOverride
                        ? "Edit account override"
                        : "Add account override"}
                    </Button>
                    {usage.data.policyOverride ? (
                      <Button
                        variant="outline"
                        onClick={() =>
                          setClearingRevision(
                            usage.data!.policyOverride!.revision,
                          )
                        }
                      >
                        Clear account override
                      </Button>
                    ) : null}
                  </>
                ) : null}
              </div>
              <AccountPolicyOverrideDialog
                open={editingRevision != null}
                onOpenChange={(open) => {
                  if (!open) setEditingRevision(null);
                }}
                currentSeconds={usage.data.processing.limitSeconds}
                currentExpiry={usage.data.policyOverride?.expiresAt ?? null}
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
                title="Clear account policy override"
                description="Return this account to the global standard policy. Existing usage and accepted reservations are not changed."
                confirmLabel="Clear override"
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
