import { useState } from "react";
import { toast } from "sonner";
import { BellRing } from "lucide-react";
import {
  createOperationId,
  OperationOutcomeUnknownError,
} from "@/api/api-client";
import { useAdminSession, useApiClient } from "@/auth/admin-session";
import { useLiveQuery } from "@/realtime/hooks";
import {
  PageHeader,
  LoadingState,
  ErrorState,
  EmptyState,
} from "@/components/page";
import { CursorPagination } from "@/components/cursor-pagination";
import { ReasonDialog } from "@/components/reason-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";
import { sendNotification } from "./notifications-api";

export function NotificationsPage() {
  const client = useApiClient();
  const { can, reauthenticate } = useAdminSession();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState<{
    title: string;
    body: string;
    operationId: string;
  } | null>(null);
  const [uncertain, setUncertain] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const history = useLiveQuery({
    queryKey: ["notifications", cursor],
    resource: "admin.notifications",
    params: { cursor },
  });
  return (
    <div className="space-y-6">
      <PageHeader
        title="Push notifications"
        description="Send system announcements to users and follow FCM submission history."
      />
      {can("notifications.send") && (
        <section
          className="grid gap-6 rounded-xl border bg-card p-5 lg:grid-cols-2"
          aria-label="Compose announcement"
        >
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              setDraft({
                title: title.trim(),
                body: body.trim(),
                operationId: createOperationId(),
              });
            }}
          >
            <h2 className="text-lg font-semibold">New announcement</h2>
            <p className="text-sm text-muted-foreground">
              Audience: all active users with eligible registered devices. Users
              without push permission or a registered device cannot be reached.
            </p>
            <div className="space-y-2">
              <Label htmlFor="push-title">Title</Label>
              <Input
                id="push-title"
                required
                maxLength={80}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">{title.length}/80</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="push-body">Message</Label>
              <Textarea
                id="push-body"
                required
                maxLength={500}
                rows={5}
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {body.length}/500 · Keep lock-screen content suitable for
                everyone.
              </p>
            </div>
            <Button
              type="submit"
              disabled={!title.trim() || !body.trim() || Boolean(uncertain)}
            >
              Review broadcast
            </Button>
          </form>
          <div className="rounded-lg bg-muted/40 p-6">
            <h2 className="mb-4 text-sm font-medium text-muted-foreground">
              Notification preview
            </h2>
            <div className="space-y-2 rounded-xl border bg-background p-4 shadow-sm">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <BellRing className="size-4" aria-hidden="true" />
                MusicMute
              </div>
              <p className="break-words font-semibold" dir="auto">
                {title.trim() || "Announcement title"}
              </p>
              <p className="whitespace-pre-wrap break-words text-sm" dir="auto">
                {body.trim() || "Your message will appear here."}
              </p>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              Appearance and display depend on device permissions and app state.
              FCM acceptance does not confirm delivery or reading.
            </p>
          </div>
        </section>
      )}
      {uncertain && (
        <p
          role="alert"
          className="rounded-lg border border-destructive p-4 text-sm"
        >
          The broadcast outcome is unresolved. Sending is disabled to prevent a
          duplicate. Check history and operation {uncertain} before starting
          another broadcast.
        </p>
      )}
      <section className="space-y-3" aria-label="FCM history">
        <h2 className="text-lg font-semibold">FCM history</h2>
        <p className="text-sm text-muted-foreground">
          Counts are per device. Accepted means FCM accepted the message.
          Completed means all attempts have settled, including failures and
          skipped devices.
        </p>
        {history.isError ? (
          <ErrorState error={history.error} />
        ) : history.isPending ? (
          <LoadingState />
        ) : !history.data?.items.length ? (
          <EmptyState
            title="No announcements yet"
            description="Broadcasts sent from this dashboard will appear here."
          />
        ) : (
          <div className="space-y-3">
            {history.data.items.map((item) => (
              <article
                key={item.id}
                className="space-y-3 rounded-xl border bg-card p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h3 className="break-words font-semibold" dir="auto">
                    {item.title}
                  </h3>
                  <Badge variant="outline">{item.state}</Badge>
                </div>
                <p
                  className="whitespace-pre-wrap break-words text-sm"
                  dir="auto"
                >
                  {item.body}
                </p>
                <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
                  {Object.entries({
                    Accepted: item.counts.sent,
                    Pending: item.counts.pending,
                    Failed: item.counts.failed,
                    Invalid: item.counts.invalid,
                    Skipped: item.counts.ineligible,
                  }).map(([label, count]) => (
                    <div key={label}>
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="text-lg font-semibold tabular-nums">
                        {count}
                      </dd>
                    </div>
                  ))}
                </dl>
                {!item.targetsFrozen && (
                  <p className="text-xs text-muted-foreground">
                    Preparing the device list; counts are still growing.
                  </p>
                )}
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">
                    Queued {formatDateTime(item.createdAt)} · Audit details
                  </summary>
                  <p className="mt-2 break-words">
                    By {item.actorUid} · Reason: {item.reason}
                  </p>
                  <p>
                    Broadcast {item.id}
                    {item.completedAt
                      ? ` · Completed ${formatDateTime(item.completedAt)}`
                      : ""}
                  </p>
                </details>
              </article>
            ))}
          </div>
        )}
        <CursorPagination
          cursor={cursor}
          nextCursor={history.data?.nextCursor ?? null}
          pending={history.isPending}
          onCursorChange={setCursor}
        />
      </section>
      <ReasonDialog
        open={Boolean(draft)}
        onOpenChange={(open) => {
          if (!open) setDraft(null);
        }}
        title="Send to all eligible users?"
        description="This queues a broadcast immediately. It cannot be recalled once submitted to FCM."
        confirmLabel="Send broadcast"
        freshAuth
        onReauthenticate={reauthenticate}
        summary={
          <div>
            <p className="font-semibold" dir="auto">
              {draft?.title}
            </p>
            <p className="whitespace-pre-wrap break-words" dir="auto">
              {draft?.body}
            </p>
          </div>
        }
        onConfirm={async (reason) => {
          if (!draft || uncertain) return;
          try {
            await sendNotification(client, { ...draft, reason });
            setTitle("");
            setBody("");
            setCursor(null);
            toast.success(
              "Broadcast queued. Follow its progress in FCM history.",
            );
          } catch (error) {
            if (error instanceof OperationOutcomeUnknownError) {
              setUncertain(draft.operationId);
              setDraft(null);
            }
            throw error;
          }
        }}
      />
    </div>
  );
}
