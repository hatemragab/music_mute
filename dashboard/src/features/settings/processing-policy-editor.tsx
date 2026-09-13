import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createOperationId } from "@/api/api-client";
import type {
  ProcessingPolicyV2,
  ProcessingQualification,
} from "@/api/contracts";
import { useAdminSession, useApiClient } from "@/auth/admin-session";
import { ErrorState, LoadingState, PageSection } from "@/components/page";
import { ReasonDialog } from "@/components/reason-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  getProcessingPolicyV2,
  updateProcessingPolicyV2,
} from "./settings-api";
import { ProcessingPolicySummary } from "./processing-policy-summary";

import {
  type Draft,
  policyFields,
  qualificationNumbers,
  emptyQualification,
  validatePolicyDraft,
} from "./processing-policy-validation";
const toDraft = (policy: ProcessingPolicyV2): Draft => {
  const draft = { ...policy } as Partial<ProcessingPolicyV2>;
  delete draft.revision;
  delete draft.updatedAt;
  delete draft.readiness;
  delete draft.shortLongThresholdSeconds;
  return { ...draft, qualification: policy.qualification ?? null } as Draft;
};

export function ProcessingPolicyEditor({
  onDirtyChange,
}: {
  onDirtyChange(dirty: boolean): void;
}) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { can, reauthenticate } = useAdminSession();
  const policy = useQuery({
    queryKey: ["processing-policy-v2"],
    queryFn: () => getProcessingPolicyV2(client),
    enabled: can("settings.read"),
  });
  const [edited, setEdited] = useState<{
    value: Draft;
    revision: number;
  } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const draft = edited?.value ?? (policy.data ? toDraft(policy.data) : null);
  const dirty = Boolean(
    edited &&
    policy.data &&
    JSON.stringify(edited.value) !== JSON.stringify(toDraft(policy.data)),
  );
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  const save = useMutation({
    mutationFn: (reason: string) => {
      if (!edited || !can("settings.manage"))
        throw new Error("Editing permission and a draft are required.");
      const errors = validatePolicyDraft(
        edited.value,
        new Date(),
        policy.data?.qualification,
      );
      if (errors.length) throw new Error(errors.join(" "));
      return updateProcessingPolicyV2(client, {
        ...edited.value,
        expectedRevision: edited.revision,
        operationId: createOperationId(),
        reason,
      });
    },
    onSuccess: (result) => {
      queryClient.setQueryData(["processing-policy-v2"], result);
      setEdited(null);
    },
  });
  if (!can("settings.read")) return null;
  if (policy.isLoading) return <LoadingState />;
  if (policy.isError || !policy.data || !draft)
    return (
      <ErrorState error={policy.error} retry={() => void policy.refetch()} />
    );
  const data = policy.data;
  const change = (value: Draft) =>
    setEdited({ value, revision: edited?.revision ?? data.revision });
  const qualify = (value: ProcessingQualification) =>
    change({ ...draft, qualification: value });
  const q = draft.qualification;
  const manage = can("settings.manage") && !save.isPending;
  const errors = validatePolicyDraft(draft, new Date(), data.qualification);
  const revisionChanged = edited && edited.revision !== data.revision;
  return (
    <Card>
      <CardContent className="space-y-5 p-5">
        <PageSection title="Media and fair queue policy (version 2)">
          <div className="space-y-5">
            <ProcessingPolicySummary readiness={data.readiness} />
            <p className="text-sm">
              Revision {data.revision} · One unfinished job per account ·
              24-hour rolling allowance · Duration and prepared-byte limits are
              inclusive.
            </p>
            <p className="text-sm text-muted-foreground">
              Short/long reporting boundary:{" "}
              {data.shortLongThresholdSeconds == null
                ? "Unavailable"
                : `${data.shortLongThresholdSeconds / 60} minutes`}
              . Scheduling uses estimated work and aging; this boundary does not
              create fixed queue tiers.
            </p>
            <fieldset disabled={!manage} className="space-y-5">
              <div className="flex flex-wrap gap-6">
                <div className="flex items-center gap-3">
                  <Switch
                    id="v2-admissions"
                    checked={draft.acceptNewJobs}
                    onCheckedChange={(value) =>
                      change({ ...draft, acceptNewJobs: value })
                    }
                  />
                  <Label htmlFor="v2-admissions">Accept new submissions</Label>
                </div>
                <div className="flex items-center gap-3">
                  <Switch
                    id="v2-long"
                    disabled={
                      !data.readiness.expandedAdmissionAvailable &&
                      !draft.acceptLongJobs
                    }
                    checked={draft.acceptLongJobs}
                    onCheckedChange={(value) =>
                      change({ ...draft, acceptLongJobs: value })
                    }
                  />
                  <Label htmlFor="v2-long">Accept new long jobs</Label>
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {policyFields.map(([key, label, scale, min, max]) => (
                  <div className="space-y-2" key={key}>
                    <Label htmlFor={`v2-${key}`}>{label}</Label>
                    <Input
                      id={`v2-${key}`}
                      type="number"
                      step="any"
                      min={min / scale}
                      max={max / scale}
                      value={
                        Number.isFinite(draft[key]) ? draft[key] / scale : ""
                      }
                      onChange={(event) =>
                        change({
                          ...draft,
                          [key]:
                            event.target.value === ""
                              ? NaN
                              : Number(event.target.value) * scale,
                        })
                      }
                    />
                  </div>
                ))}
              </div>
              <details className="rounded-lg border p-4">
                <summary className="cursor-pointer font-medium">
                  Measured qualification and source bounds
                </summary>
                <p className="my-3 text-sm text-muted-foreground">
                  Attach existing benchmark evidence only. Saving qualification
                  does not create worker capacity; fresh compatible workers must
                  also be registered. Missing values stay unavailable.
                </p>
                {!q ? (
                  <Button
                    variant="outline"
                    onClick={() => qualify({ ...emptyQualification })}
                  >
                    Attach measured qualification
                  </Button>
                ) : (
                  <div className="space-y-4">
                    <div className="grid gap-4 md:grid-cols-2">
                      {(
                        [
                          "evidenceReference",
                          "compatibilityRevision",
                          "costModelRevision",
                          "measuredAt",
                          "expiresAt",
                        ] as const
                      ).map((key) => (
                        <div className="space-y-2" key={key}>
                          <Label htmlFor={`q-${key}`}>
                            {
                              {
                                evidenceReference: "Evidence reference",
                                compatibilityRevision: "Compatibility revision",
                                costModelRevision: "Cost model revision",
                                measuredAt:
                                  "Measured at (ISO 8601 with timezone)",
                                expiresAt:
                                  "Expires at (ISO 8601 with timezone)",
                              }[key]
                            }
                          </Label>
                          <Input
                            id={`q-${key}`}
                            value={q[key]}
                            onChange={(event) =>
                              qualify({ ...q, [key]: event.target.value })
                            }
                          />
                        </div>
                      ))}
                      <div className="space-y-2">
                        <Label htmlFor="q-workers">
                          Qualified worker IDs (comma separated)
                        </Label>
                        <Input
                          id="q-workers"
                          value={q.qualifiedWorkerIds.join(", ")}
                          onChange={(event) =>
                            qualify({
                              ...q,
                              qualifiedWorkerIds: event.target.value
                                .split(",")
                                .map((id) => id.trim()),
                            })
                          }
                        />
                      </div>
                      {qualificationNumbers.map(([key, label, min, max]) => (
                        <div key={key} className="space-y-2">
                          <Label htmlFor={`q-${key}`}>{label}</Label>
                          <Input
                            id={`q-${key}`}
                            type="number"
                            step="any"
                            min={min}
                            max={max}
                            value={Number.isFinite(q[key]) ? q[key] : ""}
                            onChange={(event) =>
                              qualify({
                                ...q,
                                [key]:
                                  event.target.value === ""
                                    ? NaN
                                    : Number(event.target.value),
                              })
                            }
                          />
                        </div>
                      ))}
                    </div>
                    <Button
                      variant="outline"
                      onClick={() =>
                        change({
                          ...draft,
                          qualification: null,
                          acceptLongJobs: false,
                        })
                      }
                    >
                      Remove qualification from draft
                    </Button>
                  </div>
                )}
              </details>
            </fieldset>
            {dirty && errors.length ? (
              <ul
                className="list-inside list-disc text-sm text-destructive"
                role="alert"
              >
                {errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            ) : null}
            {revisionChanged ? (
              <div
                role="alert"
                className="space-y-2 rounded-lg border p-3 text-sm"
              >
                <p>
                  The server revision changed. Your draft is preserved; review
                  the current server values before saving.
                </p>
                <Button
                  variant="outline"
                  onClick={() =>
                    setEdited({ value: draft, revision: data.revision })
                  }
                >
                  Use refreshed revision for review
                </Button>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-3">
              <Button variant="outline" onClick={() => void policy.refetch()}>
                Refresh server policy
              </Button>
              {manage ? (
                <Button
                  disabled={
                    !dirty || errors.length > 0 || Boolean(revisionChanged)
                  }
                  onClick={() => setConfirming(true)}
                >
                  Review policy changes
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Your role can inspect this policy but cannot submit changes.
                </p>
              )}
            </div>
            <ReasonDialog
              open={confirming}
              onOpenChange={setConfirming}
              title="Save media and queue policy"
              description="Accepted jobs keep their snapshots. This does not cancel jobs or change worker slots. Confirm exact values after fresh authentication."
              confirmLabel="Save policy"
              freshAuth
              onReauthenticate={reauthenticate}
              summary={
                <div className="max-h-64 space-y-2 overflow-auto text-xs">
                  <p>Expected revision: {edited?.revision}</p>
                  {policyFields.map(([key, label]) => (
                    <p key={key}>
                      {label}: {data[key]} → {draft[key]} (server units)
                    </p>
                  ))}
                  <p>
                    Admissions: {String(data.acceptNewJobs)} →{" "}
                    {String(draft.acceptNewJobs)}
                  </p>
                  <p>
                    New long jobs: {String(data.acceptLongJobs)} →{" "}
                    {String(draft.acceptLongJobs)}
                  </p>
                  <p>
                    Qualification:{" "}
                    {data.qualification?.evidenceReference ?? "None"} →{" "}
                    {q?.evidenceReference ?? "None"}
                  </p>
                  {(
                    [
                      "compatibilityRevision",
                      "costModelRevision",
                      "measuredAt",
                      "expiresAt",
                    ] as const
                  ).map((key) => (
                    <p key={key}>
                      {key}: {data.qualification?.[key] ?? "Unavailable"} →{" "}
                      {q?.[key] ?? "Unavailable"}
                    </p>
                  ))}
                  {q ? (
                    <>
                      {qualificationNumbers.map(([key, label]) => (
                        <p key={key}>
                          {label}: {data.qualification?.[key] ?? "Unavailable"}{" "}
                          → {q[key]}
                        </p>
                      ))}
                      <p>
                        Workers:{" "}
                        {data.qualification?.qualifiedWorkerIds.join(", ") ||
                          "None"}{" "}
                        → {q.qualifiedWorkerIds.join(", ")}
                      </p>
                    </>
                  ) : null}
                </div>
              }
              onConfirm={(reason) =>
                save
                  .mutateAsync(reason)
                  .then(() => undefined)
                  .catch(async (error) => {
                    await policy.refetch();
                    throw error;
                  })
              }
            />
          </div>
        </PageSection>
      </CardContent>
    </Card>
  );
}
