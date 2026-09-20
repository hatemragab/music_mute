import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ShieldOff, ShieldX } from "lucide-react";
import { Link, useParams } from "react-router";

import { createOperationId } from "@/api/api-client";
import type { RestrictionReasonCode } from "@/api/contracts";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDateTime } from "@/lib/format";
import { AccountRestrictionExpiryField } from "./account-restriction-expiry-field";
import { restrictionExpiry } from "./processing-access-validation";
import { ProcessingUsageSection } from "./processing-usage-panel";
import {
  getAccountRestriction,
  getUser,
  putAccountRestriction,
  removeAccountRestriction,
} from "./users-api";

export function UserDetailPage() {
  const { id = "" } = useParams();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { can, reauthenticate } = useAdminSession();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [expiry, setExpiry] = useState("");
  const [reasonCode, setReasonCode] =
    useState<RestrictionReasonCode>("manual_review");
  const user = useQuery({
    queryKey: ["user", id],
    queryFn: () => getUser(client, id),
    enabled: Boolean(id),
  });
  const restriction = useQuery({
    queryKey: ["account-restriction", id],
    queryFn: () => getAccountRestriction(client, id),
    enabled: Boolean(id),
  });
  const active = restriction.data?.status === "active";
  const update = useMutation({
    mutationFn: async (note: string) => {
      if (restriction.data?.status === "active") {
        return removeAccountRestriction(client, id, {
          expectedRevision: restriction.data.revision,
          operationId: createOperationId(),
          reason: note,
        });
      }
      const expiresAt = restrictionExpiry(expiry);
      return putAccountRestriction(client, id, {
        expectedRevision: restriction.data?.revision ?? 0,
        operationId: createOperationId(),
        reasonCode,
        note,
        ...(expiresAt ? { expiresAt } : {}),
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["account-restriction", id],
        }),
        queryClient.invalidateQueries({ queryKey: ["user", id] }),
        queryClient.invalidateQueries({ queryKey: ["users"] }),
        queryClient.invalidateQueries({ queryKey: ["abuse-events"] }),
        queryClient.invalidateQueries({ queryKey: ["audit"] }),
      ]);
    },
  });

  if (user.isLoading || restriction.isLoading) return <LoadingState />;
  if (user.isError || !user.data)
    return <ErrorState error={user.error} retry={() => void user.refetch()} />;
  if (restriction.isError)
    return (
      <ErrorState
        error={restriction.error}
        retry={() => void restriction.refetch()}
      />
    );
  const data = user.data;
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
          can("users.restrictions.manage") ? (
            <Button
              variant={active ? "default" : "destructive"}
              onClick={() => {
                setExpiry("");
                setReasonCode("manual_review");
                setDialogOpen(true);
              }}
            >
              {active ? (
                <ShieldOff aria-hidden="true" />
              ) : (
                <ShieldX aria-hidden="true" />
              )}
              {active ? "Remove restriction" : "Restrict account"}
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
                  </div>
                ) : null}
              </dl>
            </PageSection>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <PageSection title="Abuse restriction">
              <StatusBadge
                value={active ? "warning" : "active"}
                label={active ? "Restricted" : "Not restricted"}
              />
              <p className="mt-3 text-sm text-muted-foreground">
                {active
                  ? "New jobs, uploads, downloads, and user retries are blocked. Authentication, account status, deletion, and recovery remain available."
                  : "No manual abuse restriction is active. Normal account quotas and service limits still apply."}
              </p>
              {restriction.data ? (
                <dl className="mt-4 grid gap-2 text-sm">
                  <div>
                    <dt className="text-muted-foreground">Reason type</dt>
                    <dd>{restriction.data.reasonCode.replaceAll("_", " ")}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Note</dt>
                    <dd>{restriction.data.note}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Expiry</dt>
                    <dd>
                      {restriction.data.expiresAt
                        ? formatDateTime(restriction.data.expiresAt)
                        : "No automatic expiry"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Updated by</dt>
                    <dd className="font-mono">{restriction.data.updatedBy}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Revision</dt>
                    <dd className="font-mono">{restriction.data.revision}</dd>
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
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={active ? "Remove account restriction" : "Restrict account"}
        description={
          active
            ? "Normal processing access will resume subject to account quotas and service limits."
            : "This immediately cancels unfinished work and blocks new cost-creating processing actions."
        }
        confirmLabel={active ? "Remove restriction" : "Restrict account"}
        destructive={!active}
        freshAuth
        onReauthenticate={reauthenticate}
        summary={
          !active ? (
            <div className="space-y-3">
              <Select
                value={reasonCode}
                onValueChange={(value) =>
                  setReasonCode(value as RestrictionReasonCode)
                }
              >
                <SelectTrigger aria-label="Restriction reason type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="manual_review">Manual review</SelectItem>
                  <SelectItem value="repeated_limit_bypass">
                    Repeated limit bypass
                  </SelectItem>
                  <SelectItem value="provider_cost_risk">
                    Provider cost risk
                  </SelectItem>
                  <SelectItem value="terms_violation">
                    Terms violation
                  </SelectItem>
                </SelectContent>
              </Select>
              <AccountRestrictionExpiryField
                value={expiry}
                onChange={setExpiry}
              />
            </div>
          ) : (
            <p>{restriction.data?.note}</p>
          )
        }
        onConfirm={(reason) => update.mutateAsync(reason).then(() => undefined)}
      />
    </div>
  );
}
