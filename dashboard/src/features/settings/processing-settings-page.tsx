import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";

import { createOperationId } from "@/api/api-client";
import type { ProcessingSettings } from "@/api/contracts";
import { useAdminSession, useApiClient } from "@/auth/admin-session";
import { ErrorState, LoadingState, PageHeader } from "@/components/page";
import { ReasonDialog } from "@/components/reason-dialog";
import { UnsavedChangesGuard } from "@/components/unsaved-changes-guard";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import {
  ProcessingSettingsForm,
  type ProcessingSettingsDraft,
  validateProcessingSettings,
} from "./processing-settings-form";
import {
  getProcessingSettings,
  updateProcessingSettings,
} from "./settings-api";

const toDraft = (value: ProcessingSettings): ProcessingSettingsDraft => ({
  acceptNewJobs: value.acceptNewJobs,
  maintenanceMessageEn: value.maintenanceMessageEn,
  maintenanceMessageAr: value.maintenanceMessageAr,
  maxInputBytesExclusive: value.maxInputBytesExclusive,
  maxDurationSecondsExclusive: value.maxDurationSecondsExclusive,
  maxActiveJobsPerUser: value.maxActiveJobsPerUser,
});

export function ProcessingSettingsPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { can, reauthenticate } = useAdminSession();
  const [editedDraft, setEditedDraft] =
    useState<ProcessingSettingsDraft | null>(null);
  const [confirming, setConfirming] = useState(false);
  const settings = useQuery({
    queryKey: ["processing-settings"],
    queryFn: () => getProcessingSettings(client),
  });
  const draft = editedDraft ?? (settings.data ? toDraft(settings.data) : null);
  const dirty = useMemo(
    () =>
      Boolean(
        settings.data &&
        draft &&
        JSON.stringify(toDraft(settings.data)) !== JSON.stringify(draft),
      ),
    [draft, settings.data],
  );
  const save = useMutation({
    mutationFn: (reason: string) => {
      if (!settings.data || !draft)
        throw new Error("Settings are unavailable.");
      return updateProcessingSettings(client, {
        ...draft,
        expectedRevision: settings.data.revision,
        operationId: createOperationId(),
        reason,
      });
    },
    onSuccess: async (result) => {
      setEditedDraft(toDraft(result));
      await queryClient.invalidateQueries({
        queryKey: ["processing-settings"],
      });
    },
  });
  if (settings.isLoading || !draft) return <LoadingState />;
  if (settings.isError || !settings.data)
    return (
      <ErrorState
        error={settings.error}
        retry={() => void settings.refetch()}
      />
    );
  const manage = can("settings.manage");
  const errors = validateProcessingSettings(draft);
  return (
    <div className="space-y-6">
      <UnsavedChangesGuard enabled={dirty} />
      <PageHeader
        title="Processing settings"
        description="Admission and workload ceilings. Model, output stem, retention, billing and host power are fixed outside this dashboard."
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
              Revision{" "}
              <strong className="font-mono">{settings.data.revision}</strong>
            </span>
            <span className="text-muted-foreground">
              Updated {formatDateTime(settings.data.updatedAt)}
            </span>
          </div>
          <ProcessingSettingsForm
            value={draft}
            onChange={setEditedDraft}
            disabled={!manage}
          />
          {!manage ? (
            <p className="rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">
              Your role can inspect these settings but cannot change them.
            </p>
          ) : null}
        </CardContent>
      </Card>
      <ReasonDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Save processing settings"
        description="Fresh authentication does not save automatically. Review the exact before and after values, then confirm with a reason."
        confirmLabel="Save settings"
        freshAuth
        onReauthenticate={reauthenticate}
        summary={
          <div className="grid gap-1 font-mono text-xs">
            <p>
              Accept jobs: {String(settings.data.acceptNewJobs)} →{" "}
              {String(draft.acceptNewJobs)}
            </p>
            <p>
              Input bytes: {settings.data.maxInputBytesExclusive} →{" "}
              {draft.maxInputBytesExclusive}
            </p>
            <p>
              Duration: {settings.data.maxDurationSecondsExclusive} →{" "}
              {draft.maxDurationSecondsExclusive}
            </p>
            <p>
              Active/user: {settings.data.maxActiveJobsPerUser ?? "Unlimited"} →{" "}
              {draft.maxActiveJobsPerUser ?? "Unlimited"}
            </p>
          </div>
        }
        onConfirm={(reason) => save.mutateAsync(reason).then(() => undefined)}
      />
    </div>
  );
}
