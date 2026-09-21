import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, RefreshCw, ShieldAlert, XCircle } from "lucide-react";
import { Link, useSearchParams } from "react-router";

import { createOperationId } from "@/api/api-client";
import type { AccountRecoveryRequest } from "@/api/contracts";
import { DASHBOARD_POLL_INTERVAL_MS } from "@/app/polling";
import { useAdminSession, useApiClient } from "@/auth/admin-session";
import { CursorPagination } from "@/components/cursor-pagination";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
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
import { useVisibleInterval } from "@/hooks/use-visible-interval";
import { formatDateTime } from "@/lib/format";
import {
  decideAccountRecoveryRequest,
  listAccountRecoveryRequests,
} from "./account-recovery-api";

type Decision = {
  request: AccountRecoveryRequest;
  action: "approve" | "reject";
};

export function AccountRecoveryPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { reauthenticate } = useAdminSession();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "pending";
  const cursor = params.get("cursor");
  const [decision, setDecision] = useState<Decision | null>(null);
  const requests = useQuery({
    queryKey: ["account-recovery-requests", status, cursor],
    queryFn: () =>
      listAccountRecoveryRequests(client, {
        status,
        cursor,
      }),
  });
  useVisibleInterval(
    () => void requests.refetch(),
    DASHBOARD_POLL_INTERVAL_MS.background,
  );
  const decide = useMutation({
    mutationFn: ({ target, reason }: { target: Decision; reason: string }) =>
      decideAccountRecoveryRequest(client, target.request, target.action, {
        expectedRevision: target.request.revision,
        operationId: createOperationId(),
        reason,
      }),
    onSuccess: async (_, variables) => {
      setDecision(null);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["account-recovery-requests"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["account-recovery-summary"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["user", variables.target.request.user.id],
        }),
        queryClient.invalidateQueries({ queryKey: ["users"] }),
      ]);
    },
  });
  const changeStatus = (value: string) => {
    const next = new URLSearchParams(params);
    if (value === "pending") next.delete("status");
    else next.set("status", value);
    next.delete("cursor");
    setParams(next);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Account recovery"
        description="High-priority requests from people who signed in while their account was scheduled for deletion. Review before the recovery deadline."
        actions={
          <Button variant="outline" onClick={() => void requests.refetch()}>
            <RefreshCw aria-hidden="true" /> Refresh
          </Button>
        }
      />
      {status === "pending" ? (
        <div className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm">
          <ShieldAlert
            aria-hidden="true"
            className="mt-0.5 size-5 shrink-0 text-red-600"
          />
          <div>
            <p className="font-semibold text-red-700 dark:text-red-300">
              High-priority review queue
            </p>
            <p className="mt-1 text-muted-foreground">
              Approving restores account access and keeps any independent
              account restriction unchanged.
            </p>
          </div>
        </div>
      ) : null}
      <Select value={status} onValueChange={changeStatus}>
        <SelectTrigger
          className="w-56"
          aria-label="Filter recovery request status"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="pending">Pending</SelectItem>
          <SelectItem value="approved">Approved</SelectItem>
          <SelectItem value="rejected">Rejected</SelectItem>
          <SelectItem value="expired">Expired</SelectItem>
          <SelectItem value="all">All requests</SelectItem>
        </SelectContent>
      </Select>
      {requests.isLoading ? (
        <LoadingState />
      ) : requests.isError ? (
        <ErrorState
          error={requests.error}
          retry={() => void requests.refetch()}
        />
      ) : requests.data?.items.length ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {requests.data.items.map((request) => (
            <Card key={request.id} className="overflow-hidden">
              <CardContent className="space-y-4 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <Link
                      to={`/users/${request.user.id}`}
                      className="font-semibold hover:underline"
                    >
                      {request.user.displayName || request.user.email || "User"}
                    </Link>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      {request.user.id}
                    </p>
                  </div>
                  <StatusBadge value={request.status} />
                </div>
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">Requested</dt>
                    <dd>{formatDateTime(request.requestedAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Recovery deadline</dt>
                    <dd className="font-medium text-red-700 dark:text-red-300">
                      {formatDateTime(request.recoverUntil)}
                    </dd>
                  </div>
                </dl>
                {request.user.deletionPhase ||
                request.user.deletionFailureCode ? (
                  <div className="rounded-lg border bg-muted/20 p-3 text-sm">
                    <p>
                      Deletion phase: {request.user.deletionPhase || "pending"}
                    </p>
                    {request.user.deletionFailureCode ? (
                      <p className="mt-1 text-amber-700 dark:text-amber-300">
                        Cleanup is waiting for a dependency and will retry
                        automatically.
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <div className="rounded-lg border bg-muted/20 p-3 text-sm">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    User reason
                  </p>
                  <p className="mt-2 whitespace-pre-wrap">
                    {request.reason || "No reason was provided."}
                  </p>
                </div>
                {request.reviewReason ? (
                  <div className="text-sm text-muted-foreground">
                    Review note: {request.reviewReason}
                  </div>
                ) : null}
                {request.status === "pending" ? (
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      variant="outline"
                      onClick={() => setDecision({ request, action: "reject" })}
                    >
                      <XCircle aria-hidden="true" /> Reject
                    </Button>
                    <Button
                      onClick={() =>
                        setDecision({ request, action: "approve" })
                      }
                    >
                      <CheckCircle2 aria-hidden="true" /> Recover account
                    </Button>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState
          title="No recovery requests"
          description="No account recovery requests match this status."
        />
      )}
      <CursorPagination
        cursor={cursor}
        nextCursor={requests.data?.nextCursor ?? null}
        pending={requests.isFetching}
        onCursorChange={(value) => {
          const next = new URLSearchParams(params);
          if (value) next.set("cursor", value);
          else next.delete("cursor");
          setParams(next);
        }}
      />
      <ReasonDialog
        open={Boolean(decision)}
        onOpenChange={(open) => {
          if (!open) setDecision(null);
        }}
        title={
          decision?.action === "approve"
            ? "Recover account"
            : "Reject recovery request"
        }
        description={
          decision?.action === "approve"
            ? "This immediately restores account access. The scheduled purge is cancelled."
            : "The account remains inaccessible and permanent deletion stays scheduled."
        }
        confirmLabel={
          decision?.action === "approve" ? "Recover account" : "Reject request"
        }
        destructive={decision?.action === "reject"}
        freshAuth
        onReauthenticate={reauthenticate}
        summary={
          decision ? (
            <>
              <p>
                {decision.request.user.displayName ||
                  decision.request.user.email}
              </p>
              <p className="text-muted-foreground">
                Deadline {formatDateTime(decision.request.recoverUntil)}
              </p>
            </>
          ) : null
        }
        onConfirm={(reason) =>
          decision
            ? decide
                .mutateAsync({ target: decision, reason })
                .then(() => undefined)
            : Promise.resolve()
        }
      />
    </div>
  );
}
