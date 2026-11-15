import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { InlineBusy } from "./page";
import { ApiError } from "@/api/api-client";

interface ReasonDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  freshAuth?: boolean;
  summary?: React.ReactNode;
  onReauthenticate?(): Promise<void>;
  onConfirm(reason: string): Promise<void>;
}

export function ReasonDialog(props: ReasonDialogProps) {
  return props.open ? <OpenReasonDialog {...props} /> : null;
}

function OpenReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = false,
  freshAuth = false,
  summary,
  onReauthenticate,
  onConfirm,
}: ReasonDialogProps) {
  const [reason, setReason] = useState("");
  const [reauthenticated, setReauthenticated] = useState(!freshAuth);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);

  const reauthenticate = async () => {
    setBusy(true);
    setError(null);
    setRequestId(null);
    try {
      await onReauthenticate?.();
      setReauthenticated(true);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Reauthentication failed.",
      );
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!reason.trim()) return;
    setBusy(true);
    setError(null);
    setRequestId(null);
    try {
      await onConfirm(reason.trim());
      onOpenChange(false);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The operation failed.",
      );
      setRequestId(
        caught instanceof ApiError ? (caught.requestId ?? null) : null,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={summary ? "sm:max-w-4xl" : undefined}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {summary ? (
          <div className="rounded-lg border bg-muted/30 p-3 text-sm">
            {summary}
          </div>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor="operation-reason">Reason</Label>
          <Textarea
            id="operation-reason"
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Record why this change is needed"
          />
          <p className="text-xs text-muted-foreground">
            Required · {reason.length}/500
          </p>
        </div>
        {error ? (
          <div className="text-sm text-destructive" role="alert">
            <p>{error}</p>
            {requestId ? (
              <p className="font-mono text-xs">Request {requestId}</p>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={busy}>
              Cancel
            </Button>
          </DialogClose>
          {!reauthenticated ? (
            <Button
              disabled={busy || !reason.trim()}
              onClick={() => void reauthenticate()}
            >
              {busy ? (
                <InlineBusy label="Reauthenticating" />
              ) : (
                "Reauthenticate with Google"
              )}
            </Button>
          ) : (
            <Button
              variant={destructive ? "destructive" : "default"}
              disabled={busy || !reason.trim()}
              onClick={() => void submit()}
            >
              {busy ? <InlineBusy label="Submitting" /> : confirmLabel}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
