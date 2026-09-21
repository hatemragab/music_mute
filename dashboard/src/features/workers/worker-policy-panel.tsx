import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { createOperationId } from "@/api/api-client";
import { useAdminSession, useApiClient } from "@/auth/admin-session";
import { ErrorState, LoadingState, PageSection } from "@/components/page";
import { ReasonDialog } from "@/components/reason-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { formatDateTime } from "@/lib/format";
import { getWorkerFleetPolicy, updateWorkerFleetPolicy } from "./worker-api";
import { workerRecipeLabel } from "./worker-recipes";
import type { WorkerFleetPolicy } from "./worker-types";

const validPolicy = (policy: WorkerFleetPolicy) =>
  Number.isInteger(policy.leaseSeconds) &&
  policy.leaseSeconds >= 15 &&
  policy.leaseSeconds <= 300 &&
  Number.isInteger(policy.processingDeadlineSeconds) &&
  policy.processingDeadlineSeconds >= 60 &&
  policy.processingDeadlineSeconds <= 7200 &&
  Number.isInteger(policy.maxAttempts) &&
  policy.maxAttempts >= 1 &&
  policy.maxAttempts <= 10 &&
  policy.recipes.every(
    (recipe) =>
      Number.isInteger(recipe.maxSlotsPerMachine) &&
      recipe.maxSlotsPerMachine >= 1 &&
      recipe.maxSlotsPerMachine <= 16,
  );

export function WorkerPolicyPanel() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { can, reauthenticate } = useAdminSession();
  const policy = useQuery({
    queryKey: ["worker-fleet-policy"],
    queryFn: () => getWorkerFleetPolicy(client),
  });
  const [draftOverride, setDraft] = useState<WorkerFleetPolicy | null>(null);
  const [confirming, setConfirming] = useState(false);
  const draft = draftOverride ?? policy.data ?? null;
  const update = useMutation({
    mutationFn: ({ reason }: { reason: string }) => {
      if (!draft) throw new Error("Policy data is unavailable.");
      return updateWorkerFleetPolicy(client, {
        operationId: createOperationId(),
        expectedRevision: draft.revision,
        acceptClaims: draft.acceptClaims,
        recipes: draft.recipes,
        leaseSeconds: draft.leaseSeconds,
        processingDeadlineSeconds: draft.processingDeadlineSeconds,
        maxAttempts: draft.maxAttempts,
        reason,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["worker-fleet-policy"],
      });
      await queryClient.invalidateQueries({ queryKey: ["worker-machines"] });
      setDraft(null);
    },
  });

  if (policy.isLoading) return <LoadingState />;
  if (policy.isError)
    return (
      <ErrorState error={policy.error} retry={() => void policy.refetch()} />
    );
  if (!draft) return null;
  const editable = can("workers.manage");
  return (
    <Card>
      <CardContent className="space-y-6 p-5">
        <PageSection
          title="Claim policy"
          description="Policy revisions affect new claims and future jobs. Running attempts keep their frozen recipe and deadline."
        >
          <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
            <div>
              <Label htmlFor="worker-accept-claims">Accept new claims</Label>
              <p className="text-xs text-muted-foreground">
                Disable this to stop dispatch without terminating active work.
              </p>
            </div>
            <Switch
              id="worker-accept-claims"
              checked={draft.acceptClaims}
              disabled={!editable}
              onCheckedChange={(checked) =>
                setDraft({ ...draft, acceptClaims: checked })
              }
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <NumberField
              label="Lease seconds"
              value={draft.leaseSeconds}
              min={15}
              max={300}
              disabled={!editable}
              onChange={(leaseSeconds) => setDraft({ ...draft, leaseSeconds })}
            />
            <NumberField
              label="Job deadline seconds"
              value={draft.processingDeadlineSeconds}
              min={60}
              max={7200}
              disabled={!editable}
              onChange={(processingDeadlineSeconds) =>
                setDraft({ ...draft, processingDeadlineSeconds })
              }
            />
            <NumberField
              label="Maximum attempts"
              value={draft.maxAttempts}
              min={1}
              max={10}
              disabled={!editable}
              onChange={(maxAttempts) => setDraft({ ...draft, maxAttempts })}
            />
          </div>
        </PageSection>
        <PageSection
          title="Recipe eligibility and capacity"
          description="Capacity is bounded per machine and recipe; the runtime may still advertise a lower qualified limit."
        >
          <div className="space-y-2">
            {draft.recipes.map((recipe, index) => (
              <div
                key={recipe.recipeId}
                className="grid items-center gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_auto_9rem]"
              >
                <div>
                  <p className="text-sm font-medium">
                    {workerRecipeLabel(recipe.recipeId)}
                  </p>
                  <code className="break-all text-xs text-muted-foreground">
                    Recipe contract: {recipe.recipeId}
                  </code>
                </div>
                <Switch
                  aria-label={`Enable ${workerRecipeLabel(recipe.recipeId)}`}
                  checked={recipe.enabled}
                  disabled={!editable}
                  onCheckedChange={(enabled) => {
                    const recipes = [...draft.recipes];
                    recipes[index] = { ...recipe, enabled };
                    setDraft({ ...draft, recipes });
                  }}
                />
                <Input
                  aria-label={`Maximum slots for ${workerRecipeLabel(recipe.recipeId)}`}
                  type="number"
                  min={1}
                  max={16}
                  disabled={!editable}
                  value={recipe.maxSlotsPerMachine}
                  onChange={(event) => {
                    const recipes = [...draft.recipes];
                    recipes[index] = {
                      ...recipe,
                      maxSlotsPerMachine: Number(event.target.value),
                    };
                    setDraft({ ...draft, recipes });
                  }}
                />
              </div>
            ))}
          </div>
        </PageSection>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4 text-xs text-muted-foreground">
          <span>
            Revision {draft.revision} · updated{" "}
            {formatDateTime(draft.updatedAt)}
          </span>
          {editable ? (
            <Button
              disabled={!validPolicy(draft)}
              onClick={() => setConfirming(true)}
            >
              Publish policy revision
            </Button>
          ) : null}
        </div>
        {!validPolicy(draft) ? (
          <p className="text-sm text-destructive" role="alert">
            Lease, deadline, attempts and slot values must stay within their
            displayed limits.
          </p>
        ) : null}
      </CardContent>
      <ReasonDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Publish worker policy"
        description="This creates a revision-fenced policy for new claims and future jobs. Active attempts are not rewritten."
        confirmLabel="Publish revision"
        freshAuth
        onReauthenticate={reauthenticate}
        summary={<p>Current revision: {draft.revision}</p>}
        onConfirm={(reason) =>
          update.mutateAsync({ reason }).then(() => undefined)
        }
      />
    </Card>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange(value: number): void;
}) {
  const id = `worker-policy-${label.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <p className="text-xs text-muted-foreground">
        {min}–{max}
      </p>
    </div>
  );
}
