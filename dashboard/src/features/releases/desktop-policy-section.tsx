import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAdminSession, useApiClient } from "@/auth/admin-session";
import { createOperationId, ApiError } from "@/api/api-client";
import type { DesktopUpdatePolicy } from "@/api/contracts";
import { PageSection, ErrorState, LoadingState } from "@/components/page";
import { ReasonDialog } from "@/components/reason-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  getDesktopUpdatePolicy,
  updateDesktopPolicy,
  type DesktopPolicyCommand,
} from "./desktop-policy-api";
const KEY = ["desktop-update-policy"] as const;
export function DesktopPolicySection() {
  const client = useApiClient(),
    { can, reauthenticate } = useAdminSession(),
    queries = useQueryClient();
  const current = useQuery({
    queryKey: KEY,
    queryFn: () => getDesktopUpdatePolicy(client),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const [edited, setEdited] = useState<DesktopUpdatePolicy | null>(null),
    [confirmation, setConfirmation] = useState<Omit<
      DesktopPolicyCommand,
      "operationId" | "reason"
    > | null>(null);
  const save = useMutation({
    mutationFn: (input: DesktopPolicyCommand) =>
      updateDesktopPolicy(client, input),
    onSuccess: (result) => {
      queries.setQueryData(KEY, result.policy);
      setEdited(null);
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.code === "REVISION_CONFLICT") {
        // Explicit command conflict readback, not recurring status fetching or write retry.
        queries.setQueryData(KEY, await getDesktopUpdatePolicy(client));
        setEdited(null);
        setConfirmation(null);
      }
    },
  });
  const value = edited ?? current.data,
    manage = can("releases.manage");
  if (current.isLoading)
    return (
      <PageSection title="Desktop build gates">
        <LoadingState />
      </PageSection>
    );
  if (current.isError || !value)
    return (
      <PageSection title="Desktop build gates">
        <ErrorState error={current.error} />
      </PageSection>
    );
  const valid = [value.macos.minimumBuild, value.windows.minimumBuild].every(
    (v) => v === null || (Number.isInteger(v) && v >= 1 && v <= 2147483647),
  );
  const changed =
    value.windows.minimumBuild !== current.data?.windows.minimumBuild ||
    value.macos.minimumBuild !== current.data?.macos.minimumBuild;
  const review = () => {
    if (!current.data || !valid) return;
    const platforms: DesktopPolicyCommand["platforms"] = {};
    for (const key of ["macos", "windows"] as const)
      if (value[key].minimumBuild !== current.data[key].minimumBuild)
        platforms[key] = { ...value[key] };
    setConfirmation({ expectedRevision: current.data.revision, platforms });
  };
  return (
    <PageSection
      title="Desktop build gates"
      description="Control cloud-processing access for desktop builds. App installer publication is configured separately from these gates and mobile releases."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {(["windows", "macos"] as const).map((platform) => (
          <div className="space-y-2" key={platform}>
            <Label htmlFor={`${platform}-build-gate`}>
              {platform === "windows" ? "Windows" : "macOS"} minimum build
            </Label>
            <Input
              id={`${platform}-build-gate`}
              type="number"
              min="1"
              max="2147483647"
              value={value[platform].minimumBuild ?? ""}
              disabled={!manage || save.isPending || confirmation !== null}
              onChange={(event) =>
                setEdited({
                  ...value,
                  [platform]: {
                    minimumBuild:
                      event.target.value === ""
                        ? null
                        : Number(event.target.value),
                  },
                })
              }
            />
          </div>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        Leave blank for no gate. Builds below the minimum must update before
        starting cloud processing. Existing downloads and local processing
        remain available.
      </p>
      {!valid ? (
        <p role="alert" className="text-sm text-destructive">
          Use a whole build number between 1 and 2147483647, or leave blank.
        </p>
      ) : null}
      <Button
        variant="outline"
        disabled={!manage || !valid || !changed || save.isPending}
        onClick={review}
      >
        Review desktop gates
      </Button>
      <ReasonDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
        title="Save desktop build gates"
        description="Review the affected desktop builds. This change updates their cloud access gate without publishing an installer or changing mobile releases."
        confirmLabel="Save desktop gates"
        freshAuth
        onReauthenticate={reauthenticate}
        summary={
          confirmation ? (
            <div>
              {Object.entries(confirmation.platforms).map(
                ([platform, gate]) => (
                  <p key={platform}>
                    {platform === "windows" ? "Windows" : "macOS"}:{" "}
                    {gate?.minimumBuild ?? "No minimum"}
                  </p>
                ),
              )}
            </div>
          ) : undefined
        }
        onConfirm={async (reason) => {
          if (!confirmation)
            throw new Error("Desktop policy review is unavailable.");
          await save.mutateAsync({
            ...confirmation,
            reason,
            operationId: createOperationId(),
          });
        }}
      />
    </PageSection>
  );
}
