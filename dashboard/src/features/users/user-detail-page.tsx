import { suspensionExpiry } from "./processing-access-validation";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, PauseCircle, PlayCircle } from "lucide-react";
import { Link, useParams } from "react-router";

import { createOperationId } from "@/api/api-client";
import type { UserDetail } from "@/api/contracts";
import { useAdminSession, useApiClient } from "@/auth/admin-session";
import {
  ErrorState,
  LoadingState,
  PageHeader,
  PageSection,
} from "@/components/page";
import { ReasonDialog } from "@/components/reason-dialog";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import { getUser, setProcessingSuspended } from "./users-api";

import { ProcessingUsageSection } from "./processing-usage-panel";

import { SuspensionExpiryField } from "./processing-suspension-dialog";

export function UserDetailPage() {
  const { id = "" } = useParams();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { can, reauthenticate } = useAdminSession();
  const [changing, setChanging] = useState<UserDetail | null>(null);
  const [expiry, setExpiry] = useState("");
  const user = useQuery({
    queryKey: ["user", id],
    queryFn: () => getUser(client, id),
    enabled: Boolean(id),
  });
  const update = useMutation({
    mutationFn: ({
      current,
      reason,
    }: {
      current: UserDetail;
      reason: string;
    }) =>
      setProcessingSuspended(client, current.id, !current.processingSuspended, {
        expectedRevision: current.revision,
        operationId: createOperationId(),
        reason,
        ...(current.processingSuspended
          ? {}
          : { expiresAt: suspensionExpiry(expiry) }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["user", id] });
      await queryClient.invalidateQueries({ queryKey: ["users"] });
      await queryClient.invalidateQueries({
        queryKey: ["processing-usage", id],
      });
      await queryClient.invalidateQueries({ queryKey: ["audit"] });
    },
  });
  if (user.isLoading) return <LoadingState />;
  if (user.isError || !user.data)
    return <ErrorState error={user.error} retry={() => void user.refetch()} />;
  const data = user.data;
  const actionUser = changing ?? data;
  return (
    <div className="space-y-6">
      <Link
        to="/users"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-4" /> Users
      </Link>
      <PageHeader
        title={data.displayName || data.email || "User"}
        description={data.id}
        actions={
          can("users.processing.manage") ? (
            <Button
              variant={data.processingSuspended ? "default" : "destructive"}
              onClick={() => {
                setExpiry("");
                setChanging(data);
              }}
            >
              {data.processingSuspended ? (
                <PlayCircle aria-hidden="true" />
              ) : (
                <PauseCircle aria-hidden="true" />
              )}
              {data.processingSuspended
                ? "Resume processing"
                : "Suspend processing"}
            </Button>
          ) : undefined
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="p-5">
            <PageSection title="Account">
              <dl className="grid gap-4 text-sm">
                <div>
                  <dt className="text-muted-foreground">Email</dt>
                  <dd>{data.email ?? "Not available"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Account status</dt>
                  <dd>
                    <StatusBadge value={data.status} />
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Created</dt>
                  <dd>{formatDateTime(data.createdAt)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Updated</dt>
                  <dd>{formatDateTime(data.updatedAt)}</dd>
                </div>
                {data.deletion ? (
                  <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3">
                    <dt className="font-medium text-red-700 dark:text-red-300">
                      Scheduled deletion
                    </dt>
                    <dd className="mt-1 text-muted-foreground">
                      Recovery deadline:{" "}
                      {data.deletion.recoverUntil
                        ? formatDateTime(data.deletion.recoverUntil)
                        : "Unavailable"}
                    </dd>
                    {data.deletion.recoveryAvailable ? (
                      <Button
                        asChild
                        variant="link"
                        className="mt-1 h-auto p-0"
                      >
                        <Link to="/account-recovery">
                          Review recovery queue
                        </Link>
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </dl>
            </PageSection>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <PageSection title="Processing access">
              <div className="mb-4">
                <StatusBadge
                  value={data.processingSuspended ? "warning" : "active"}
                  label={
                    data.processingSuspended
                      ? "Processing suspended"
                      : "Processing allowed"
                  }
                />
              </div>
              <p className="text-sm text-muted-foreground">
                {data.processingSuspended
                  ? "New processing submissions are blocked. Existing jobs and results remain available."
                  : "New processing submissions are allowed, subject to global limits."}
              </p>
              {data.suspension ? (
                <dl className="mt-4 grid gap-2 text-sm">
                  <div>
                    <dt className="text-muted-foreground">Suspension expiry</dt>
                    <dd>
                      {data.suspension.expiresAt
                        ? formatDateTime(data.suspension.expiresAt)
                        : "Until resumed"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Reason</dt>
                    <dd>{data.suspension.reason}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Changed by</dt>
                    <dd className="font-mono">{data.suspension.actorUid}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Changed at</dt>
                    <dd>{formatDateTime(data.suspension.at)}</dd>
                  </div>
                </dl>
              ) : null}
            </PageSection>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardContent className="p-5">
          <PageSection title="Processing summary">
            {Object.keys(data.processingCounts).length ? (
              <div className="flex flex-wrap gap-3">
                {Object.entries(data.processingCounts).map(
                  ([status, count]) => (
                    <div
                      key={status}
                      className="rounded-lg border bg-muted/20 px-4 py-3"
                    >
                      <div className="font-mono text-2xl font-semibold">
                        {count}
                      </div>
                      <div className="text-xs capitalize text-muted-foreground">
                        {status.replaceAll("_", " ")}
                      </div>
                    </div>
                  ),
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No processing records.
              </p>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              {data.recentJobIds.map((jobId) => (
                <Button key={jobId} variant="outline" size="sm" asChild>
                  <Link to={`/jobs/${jobId}`}>Job {jobId.slice(-8)}</Link>
                </Button>
              ))}
            </div>
          </PageSection>
        </CardContent>
      </Card>
      <ProcessingUsageSection key={id} userId={id} />
      <ReasonDialog
        open={Boolean(changing)}
        onOpenChange={(open) => {
          if (!open) setChanging(null);
        }}
        title={
          actionUser.processingSuspended
            ? "Resume processing"
            : "Suspend processing"
        }
        description={
          actionUser.processingSuspended
            ? "This allows new processing only if the account itself is active. It does not change a disabled or deleting account."
            : "New processing will be blocked. Existing jobs and results remain available."
        }
        confirmLabel={
          actionUser.processingSuspended
            ? "Resume processing"
            : "Suspend processing"
        }
        destructive={!actionUser.processingSuspended}
        freshAuth
        onReauthenticate={reauthenticate}
        summary={
          <>
            <p>{actionUser.displayName || actionUser.email}</p>
            {!actionUser.processingSuspended ? (
              <SuspensionExpiryField value={expiry} onChange={setExpiry} />
            ) : null}
            <p className="text-muted-foreground">
              Account remains {actionUser.status}
            </p>
          </>
        }
        onConfirm={(reason) =>
          update
            .mutateAsync({ current: actionUser, reason })
            .then(() => undefined)
        }
      />
    </div>
  );
}
