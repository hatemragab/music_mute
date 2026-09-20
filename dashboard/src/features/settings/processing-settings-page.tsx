import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";

import { createOperationId } from "@/api/api-client";
import type { AccountPolicy } from "@/api/contracts";
import { useAdminSession, useApiClient } from "@/auth/admin-session";
import { ErrorState, LoadingState, PageHeader } from "@/components/page";
import { ReasonDialog } from "@/components/reason-dialog";
import { UnsavedChangesGuard } from "@/components/unsaved-changes-guard";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import {
  AccountPolicyForm,
  type AccountPolicyDraft,
  validateAccountPolicy,
} from "./processing-settings-form";
import { getAccountPolicy, updateAccountPolicy } from "./settings-api";

const toDraft = (value: AccountPolicy): AccountPolicyDraft => ({
  acceptNewJobs: value.acceptNewJobs,
  maintenanceMessageEn: value.maintenanceMessageEn,
  maintenanceMessageAr: value.maintenanceMessageAr,
  values: value.values,
});

export function ProcessingSettingsPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { can, reauthenticate } = useAdminSession();
  const [editedDraft, setEditedDraft] = useState<AccountPolicyDraft | null>(
    null,
  );
  const [confirming, setConfirming] = useState(false);
  const policy = useQuery({
    queryKey: ["account-policy"],
    queryFn: () => getAccountPolicy(client),
  });
  const draft = editedDraft ?? (policy.data ? toDraft(policy.data) : null);
  const dirty = useMemo(
    () =>
      Boolean(
        policy.data &&
        draft &&
        JSON.stringify(toDraft(policy.data)) !== JSON.stringify(draft),
      ),
    [draft, policy.data],
  );
  const save = useMutation({
    mutationFn: (reason: string) => {
      if (!policy.data || !draft)
        throw new Error("Account policy is unavailable.");
      return updateAccountPolicy(client, {
        acceptNewJobs: draft.acceptNewJobs,
        maintenanceMessageEn: draft.maintenanceMessageEn,
        maintenanceMessageAr: draft.maintenanceMessageAr,
        ...draft.values,
        expectedRevision: policy.data.revision,
        operationId: createOperationId(),
        reason,
      });
    },
    onSuccess: async (result) => {
      setEditedDraft(toDraft(result));
      await queryClient.invalidateQueries({ queryKey: ["account-policy"] });
    },
  });
  if (policy.isLoading || !draft) return <LoadingState />;
  if (policy.isError || !policy.data)
    return (
      <ErrorState error={policy.error} retry={() => void policy.refetch()} />
    );
  const manage = can("settings.manage");
  const errors = validateAccountPolicy(draft);
  return (
    <div className="space-y-6">
      <UnsavedChangesGuard enabled={dirty} />
      <PageHeader
        title="Standard account policy"
        description="One revisioned policy for monthly account usage and the launch cost ceilings. Only listed enforced features are active."
        actions={
          manage ? (
            <Button
              disabled={!dirty || errors.length > 0}
              onClick={() => setConfirming(true)}
            >
              <Save aria-hidden="true" /> Review changes
            </Button>
          ) : undefined
        }
      />
      <Card>
        <CardContent className="space-y-5 p-5">
          <div className="flex flex-wrap justify-between gap-3 border-b pb-4 text-sm">
            <span>
              Plan <strong>{policy.data.plan}</strong> · revision{" "}
              <strong className="font-mono">{policy.data.revision}</strong>
            </span>
            <span className="text-muted-foreground">
              Enforced now: {policy.data.enforcedFeatures.join(", ") || "none"}
              {" · "}Updated {formatDateTime(policy.data.updatedAt)}
            </span>
          </div>
          <AccountPolicyForm
            value={draft}
            onChange={setEditedDraft}
            disabled={!manage}
          />
          {!manage ? (
            <p className="rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
              Your role can inspect this policy but cannot change it.
            </p>
          ) : null}
        </CardContent>
      </Card>
      <ReasonDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Save standard account policy"
        description="The write uses the current revision and is audited. Lowering a limit does not rewrite consumed usage or cancel accepted work."
        confirmLabel="Save policy"
        freshAuth
        onReauthenticate={reauthenticate}
        summary={
          <div className="grid gap-1 font-mono text-xs">
            <p>
              Accept jobs: {String(policy.data.acceptNewJobs)} →{" "}
              {String(draft.acceptNewJobs)}
            </p>
            <p>
              Monthly processing: {policy.data.values.monthlyProcessingSeconds}{" "}
              → {draft.values.monthlyProcessingSeconds} seconds
            </p>
            <p>
              Media ceiling: {policy.data.values.maxDurationSeconds}s /{" "}
              {policy.data.values.maxPreparedAudioBytes}B →{" "}
              {draft.values.maxDurationSeconds}s /{" "}
              {draft.values.maxPreparedAudioBytes}B
            </p>
          </div>
        }
        onConfirm={(reason) => save.mutateAsync(reason).then(() => undefined)}
      />
    </div>
  );
}
