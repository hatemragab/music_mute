import type { AuditEvent } from "@/api/contracts";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { formatDateTime } from "@/lib/format";

export function AuditEventDetail({
  event,
  onClose,
}: {
  event: AuditEvent | null;
  onClose(): void;
}) {
  return (
    <Sheet
      open={Boolean(event)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{event?.action ?? "Activity"}</SheetTitle>
          <SheetDescription>
            {event ? `${event.resourceType} ${event.resourceId}` : ""}
          </SheetDescription>
        </SheetHeader>
        {event ? (
          <dl className="mt-6 grid gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground">When</dt>
              <dd>{formatDateTime(event.at)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Actor</dt>
              <dd className="font-mono break-all">{event.actorUid}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Outcome</dt>
              <dd>{event.outcome}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Reason</dt>
              <dd className="whitespace-pre-wrap">
                {event.reason ?? "No reason recorded"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Revision</dt>
              <dd>
                {event.previousRevision ?? "—"} → {event.nextRevision ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Operation</dt>
              <dd className="font-mono break-all">
                {event.operationId ?? "None"}
              </dd>
            </div>
          </dl>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
