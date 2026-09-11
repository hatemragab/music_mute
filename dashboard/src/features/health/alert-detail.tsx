import type { AlertRecord } from "@/api/contracts";
import { StatusBadge } from "@/components/status-badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { formatDateTime } from "@/lib/format";

export function AlertDetail({
  alert,
  onClose,
}: {
  alert: AlertRecord | null;
  onClose(): void;
}) {
  return (
    <Sheet
      open={Boolean(alert)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{alert?.type ?? "Alert"}</SheetTitle>
          <SheetDescription>{alert?.message}</SheetDescription>
        </SheetHeader>
        {alert ? (
          <div className="mt-6 space-y-5 text-sm">
            <div className="flex gap-2">
              <StatusBadge value={alert.severity} />
              <StatusBadge value={alert.state} />
              {alert.acknowledgedAt ? (
                <StatusBadge value="active" label="Acknowledged" />
              ) : null}
            </div>
            <dl className="grid gap-4">
              <div>
                <dt className="text-muted-foreground">Resource</dt>
                <dd className="font-mono break-all">
                  {alert.resourceId ?? "System"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">First observed</dt>
                <dd>{formatDateTime(alert.firstSeenAt)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Last observed</dt>
                <dd>{formatDateTime(alert.lastSeenAt)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Acknowledged</dt>
                <dd>{formatDateTime(alert.acknowledgedAt)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Resolved</dt>
                <dd>{formatDateTime(alert.resolvedAt)}</dd>
              </div>
            </dl>
            <p className="rounded-lg border bg-muted/20 p-3 text-muted-foreground">
              Acknowledgment records operator awareness. It does not resolve the
              condition or release worker ownership.
            </p>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
