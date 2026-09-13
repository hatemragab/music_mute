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
      <SheetContent className="overflow-y-auto">
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
            {event.processingChanges?.length ? (
              <div>
                <dt className="text-muted-foreground">
                  Processing changes (before → after)
                </dt>
                <dd>
                  <ul className="mt-2 space-y-2">
                    {event.processingChanges.map((change) => (
                      <li key={change.field} className="break-words">
                        <span className="font-medium">{change.field}</span>:{" "}
                        {change.before == null ? "None" : String(change.before)}{" "}
                        → {change.after == null ? "None" : String(change.after)}
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            ) : null}
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
