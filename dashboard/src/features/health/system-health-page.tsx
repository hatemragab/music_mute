import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useSearchParams } from "react-router";

import { createOperationId } from "@/api/api-client";
import { ALERT_SEVERITIES, type AlertRecord } from "@/api/contracts";
import { DASHBOARD_POLL_INTERVAL_MS } from "@/app/polling";
import { useAdminSession, useApiClient } from "@/auth/admin-session";
import { CursorPagination } from "@/components/cursor-pagination";
import {
  EmptyState,
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
import { useVisibleInterval } from "@/hooks/use-visible-interval";
import { acknowledgeAlert, getHealth, listAlerts } from "./health-api";
import { AlertDetail } from "./alert-detail";
import { AlertsTable } from "./alerts-table";
import { HealthComponentCards } from "./health-component-cards";

export function SystemHealthPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { can } = useAdminSession();
  const [params, setParams] = useSearchParams();
  const stateParameter = params.get("state");
  const state =
    stateParameter === "all" || stateParameter === "resolved"
      ? stateParameter
      : "active";
  const severityParameter = params.get("severity");
  const severity = ALERT_SEVERITIES.includes(severityParameter as never)
    ? (severityParameter as (typeof ALERT_SEVERITIES)[number])
    : "all";
  const cursor = params.get("cursor");
  const [selected, setSelected] = useState<AlertRecord | null>(null);
  const [acknowledging, setAcknowledging] = useState<AlertRecord | null>(null);
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => getHealth(client),
  });
  const alerts = useQuery({
    queryKey: ["alerts", state, severity, cursor],
    queryFn: () =>
      listAlerts(client, {
        state: state === "all" ? undefined : state,
        severity: severity === "all" ? undefined : severity,
        cursor,
      }),
  });
  const change = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== "all") next.set(name, value);
    else next.delete(name);
    if (name !== "cursor") next.delete("cursor");
    setParams(next);
  };
  useVisibleInterval(() => {
    void health.refetch();
    void alerts.refetch();
  }, DASHBOARD_POLL_INTERVAL_MS.background);
  const acknowledge = useMutation({
    mutationFn: ({ alert, reason }: { alert: AlertRecord; reason: string }) =>
      acknowledgeAlert(client, alert.id, {
        expectedRevision: alert.revision,
        operationId: createOperationId(),
        reason,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["alerts"] });
      await queryClient.invalidateQueries({ queryKey: ["health"] });
    },
  });
  return (
    <div className="space-y-6">
      <PageHeader
        title="System health"
        description="Safe dependency status and durable alert episodes. Unknown or stale checks are never displayed as healthy."
        actions={
          <Button
            variant="outline"
            onClick={() => {
              void health.refetch();
              void alerts.refetch();
            }}
          >
            <RefreshCw aria-hidden="true" /> Refresh
          </Button>
        }
      />
      {health.isLoading ? (
        <LoadingState rows={3} />
      ) : health.isError ? (
        <ErrorState error={health.error} retry={() => void health.refetch()} />
      ) : health.data ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card p-4">
            <div>
              <p className="font-medium">Overall status</p>
              <p className="text-sm text-muted-foreground">
                Observed {formatDateTime(health.data.asOf)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge value={health.data.status} />
              <span className="text-sm text-muted-foreground">
                {health.data.activeAlertCount} active alerts
              </span>
            </div>
          </div>
          <HealthComponentCards components={health.data.components} />
        </>
      ) : null}
      <Card>
        <CardContent className="space-y-4 p-5">
          <PageSection
            title="Alerts"
            description="Acknowledgment and resolution are independent states."
          >
            <div className="flex gap-2">
              <Select
                value={state}
                onValueChange={(value) => change("state", value)}
              >
                <SelectTrigger className="w-40" aria-label="Filter alert state">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All states</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="resolved">Resolved</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={severity}
                onValueChange={(value) => change("severity", value)}
              >
                <SelectTrigger
                  className="w-40"
                  aria-label="Filter alert severity"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All severities</SelectItem>
                  {ALERT_SEVERITIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value === "warning" ? "Warning" : "Critical"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {alerts.isLoading ? (
              <LoadingState />
            ) : alerts.isError ? (
              <ErrorState
                error={alerts.error}
                retry={() => void alerts.refetch()}
              />
            ) : alerts.data?.items.length ? (
              <div className="overflow-x-auto rounded-lg border">
                <AlertsTable
                  alerts={alerts.data.items}
                  canManage={can("alerts.manage")}
                  onInspect={setSelected}
                  onAcknowledge={setAcknowledging}
                />
              </div>
            ) : (
              <EmptyState
                title="No alerts"
                description="No alert episodes match the selected filters."
              />
            )}
            <CursorPagination
              cursor={cursor}
              nextCursor={alerts.data?.nextCursor ?? null}
              pending={alerts.isFetching}
              onCursorChange={(value) => change("cursor", value ?? "")}
            />
          </PageSection>
        </CardContent>
      </Card>
      <AlertDetail alert={selected} onClose={() => setSelected(null)} />
      <ReasonDialog
        open={Boolean(acknowledging)}
        onOpenChange={(open) => {
          if (!open) setAcknowledging(null);
        }}
        title="Acknowledge alert"
        description="This records operator awareness only; it does not resolve the underlying condition."
        confirmLabel="Acknowledge"
        summary={
          acknowledging ? (
            <>
              <p className="font-medium">{acknowledging.type}</p>
              <p className="text-muted-foreground">{acknowledging.message}</p>
            </>
          ) : null
        }
        onConfirm={(reason) =>
          acknowledging
            ? acknowledge
                .mutateAsync({ alert: acknowledging, reason })
                .then(() => undefined)
            : Promise.resolve()
        }
      />
    </div>
  );
}
