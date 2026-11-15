import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Send, Undo2 } from "lucide-react";
import { useSearchParams } from "react-router";

import { createOperationId } from "@/api/api-client";
import type { ReleaseSummary, UpdatePolicy } from "@/api/contracts";
import { useAdminSession, useApiClient } from "@/auth/admin-session";
import {
  ErrorState,
  LoadingState,
  PageHeader,
  PageSection,
} from "@/components/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getUpdatePolicy,
  listReleases,
  previewUpdatePolicy,
  publishRelease,
  withdrawRelease,
} from "./releases-api";
import { PolicyPreview, type PolicyPreviewResult } from "./policy-preview";
import { PublishReleaseDialog } from "./publish-release-dialog";
import { UpdatePolicyForm } from "./update-policy-form";
import { WithdrawReleaseDialog } from "./withdraw-release-dialog";

export function UpdatePolicyPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { can, reauthenticate } = useAdminSession();
  const [params, setParams] = useSearchParams();
  const [editedDraft, setEditedDraft] = useState<UpdatePolicy | null>(null);
  const [preview, setPreview] = useState<PolicyPreviewResult | null>(null);
  const [storeConfirmed, setStoreConfirmed] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const policy = useQuery({
    queryKey: ["update-policy"],
    queryFn: () => getUpdatePolicy(client),
  });
  const releases = useQuery({
    queryKey: ["releases", "policy"],
    queryFn: () => listReleases(client),
  });
  const draft = editedDraft ?? policy.data ?? null;
  const releaseId = params.get("releaseId") ?? "";
  const selected = useMemo(
    () =>
      releases.data?.items.find((release) => release.id === releaseId) ?? null,
    [releaseId, releases.data],
  );
  const previewMutation = useMutation({
    mutationFn: (value: UpdatePolicy) => previewUpdatePolicy(client, value),
    onSuccess: setPreview,
  });
  const publish = useMutation({
    mutationFn: ({
      release,
      reason,
    }: {
      release: ReleaseSummary;
      reason: string;
    }) => {
      if (!draft || !policy.data) throw new Error("Policy is unavailable.");
      return publishRelease(client, release.id, {
        expectedRevision: policy.data.revision,
        expectedReleaseRevision: release.revision,
        policy: draft,
        operationId: createOperationId(),
        reason,
        storeAvailabilityConfirmed:
          release.source !== "direct_apk" && storeConfirmed,
      });
    },
    onSuccess: async () => {
      setPreview(null);
      setEditedDraft(null);
      await queryClient.invalidateQueries({ queryKey: ["update-policy"] });
      await queryClient.invalidateQueries({ queryKey: ["releases"] });
    },
  });
  const withdraw = useMutation({
    mutationFn: ({
      release,
      reason,
    }: {
      release: ReleaseSummary;
      reason: string;
    }) => {
      if (!draft || !policy.data) throw new Error("Policy is unavailable.");
      return withdrawRelease(client, release.id, {
        expectedRevision: policy.data.revision,
        expectedReleaseRevision: release.revision,
        replacementPolicy: draft,
        operationId: createOperationId(),
        reason,
      });
    },
    onSuccess: async () => {
      setPreview(null);
      setEditedDraft(null);
      await queryClient.invalidateQueries({ queryKey: ["update-policy"] });
      await queryClient.invalidateQueries({ queryKey: ["releases"] });
    },
  });
  if (policy.isLoading || releases.isLoading || !draft) return <LoadingState />;
  if (policy.isError)
    return (
      <ErrorState error={policy.error} retry={() => void policy.refetch()} />
    );
  if (releases.isError)
    return (
      <ErrorState
        error={releases.error}
        retry={() => void releases.refetch()}
      />
    );
  const manage = can("releases.manage");
  const choose = (id: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set("releaseId", id);
    else next.delete("releaseId");
    setParams(next);
    setPreview(null);
    setStoreConfirmed(false);
  };
  const updateDraft = (value: UpdatePolicy) => {
    setEditedDraft(value);
    setPreview(null);
  };
  const storeRequired = selected?.source !== "direct_apk";
  const publishEligible =
    selected?.state === "draft" &&
    (selected.source !== "direct_apk" || selected.artifactState === "verified");
  return (
    <div className="space-y-6">
      <PageHeader
        title="Update policy"
        description="Preview complete Android and iOS behavior before publication. Minimum build determines required updates."
        actions={
          <Button
            variant="outline"
            disabled={previewMutation.isPending}
            onClick={() => previewMutation.mutate(draft)}
          >
            <Eye aria-hidden="true" /> Preview policy
          </Button>
        }
      />
      <Card>
        <CardContent className="space-y-4 p-5">
          <PageSection
            title="Release operation"
            description="Choose a release, review a valid preview, then confirm publication or withdrawal."
          >
            <Select value={releaseId} onValueChange={choose}>
              <SelectTrigger className="max-w-xl" aria-label="Select release">
                <SelectValue placeholder="Select a release" />
              </SelectTrigger>
              <SelectContent>
                {releases.data?.items.map((release) => (
                  <SelectItem key={release.id} value={release.id}>
                    {release.platform} {release.versionName} (
                    {release.buildNumber}) · {release.source} · {release.state}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selected ? (
              <div className="rounded-lg border bg-muted/20 p-3 text-sm">
                <p className="font-medium">
                  {selected.versionName} ({selected.buildNumber})
                </p>
                <p className="whitespace-pre-wrap text-muted-foreground">
                  {selected.changelogEn}
                </p>
              </div>
            ) : null}
            {selected && storeRequired ? (
              <div className="flex items-start gap-3">
                <Checkbox
                  id="store-availability"
                  checked={storeConfirmed}
                  onCheckedChange={(value) => setStoreConfirmed(value === true)}
                />
                <Label htmlFor="store-availability" className="leading-relaxed">
                  I verified that this store release is available to the
                  intended audience.
                </Label>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {manage && selected && publishEligible ? (
                <Button
                  disabled={
                    !preview?.valid || (storeRequired && !storeConfirmed)
                  }
                  onClick={() => setPublishOpen(true)}
                >
                  <Send aria-hidden="true" /> Publish release
                </Button>
              ) : null}
              {manage && selected?.state === "published" ? (
                <Button
                  variant="destructive"
                  disabled={!preview?.valid}
                  onClick={() => setWithdrawOpen(true)}
                >
                  <Undo2 aria-hidden="true" /> Withdraw with replacement
                </Button>
              ) : null}
              {selected && !publishEligible && selected.state === "draft" ? (
                <p className="text-sm text-amber-700 dark:text-amber-300">
                  Direct APK publication requires a server-verified artifact.
                </p>
              ) : null}
            </div>
          </PageSection>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-5">
          <PageSection
            title="Complete policy"
            description={`Current server revision ${policy.data?.revision ?? 0}. Changing any value invalidates the previous preview.`}
          >
            <UpdatePolicyForm
              value={draft}
              onChange={updateDraft}
              disabled={!manage}
            />
          </PageSection>
        </CardContent>
      </Card>
      {previewMutation.isError ? (
        <ErrorState error={previewMutation.error} />
      ) : preview ? (
        <Card>
          <CardContent className="p-5">
            <PageSection title="Policy preview">
              <PolicyPreview result={preview} />
              <p className="mt-4 text-sm text-muted-foreground">
                Example: with minimum build 10 and latest build 12, build 9 must
                update while build 10 may update.
              </p>
            </PageSection>
          </CardContent>
        </Card>
      ) : null}
      <PublishReleaseDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        title="Publish release and policy"
        description="Fresh authentication and this final summary are required. An uncertain response is resolved by operation and policy read-back, never an automatic resend."
        confirmLabel="Publish release"
        freshAuth
        onReauthenticate={reauthenticate}
        summary={
          selected ? (
            <>
              <p className="font-medium">
                {selected.platform} {selected.versionName} (
                {selected.buildNumber})
              </p>
              <p className="text-muted-foreground">
                Policy revision {policy.data?.revision} · preview revision{" "}
                {preview?.currentRevision}
              </p>
            </>
          ) : null
        }
        onConfirm={(reason) =>
          selected
            ? publish
                .mutateAsync({ release: selected, reason })
                .then(() => undefined)
            : Promise.resolve()
        }
      />
      <WithdrawReleaseDialog
        open={withdrawOpen}
        onOpenChange={setWithdrawOpen}
        title="Withdraw release with replacement policy"
        description="Withdrawal preserves history and cannot downgrade installed apps. Confirm the replacement targets and minimum builds."
        confirmLabel="Withdraw release"
        destructive
        freshAuth
        onReauthenticate={reauthenticate}
        summary={
          selected ? (
            <p>
              {selected.platform} {selected.versionName} ({selected.buildNumber}
              )
            </p>
          ) : null
        }
        onConfirm={(reason) =>
          selected
            ? withdraw
                .mutateAsync({ release: selected, reason })
                .then(() => undefined)
            : Promise.resolve()
        }
      />
    </div>
  );
}
