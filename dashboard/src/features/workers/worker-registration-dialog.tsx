import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface WorkerRegistrationDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  reauthenticate(): Promise<void>;
  onSubmit(input: { id: string; label: string; reason: string }): Promise<void>;
}

export function WorkerRegistrationDialog(props: WorkerRegistrationDialogProps) {
  return props.open ? <OpenWorkerRegistrationDialog {...props} /> : null;
}

function OpenWorkerRegistrationDialog({
  open,
  onOpenChange,
  reauthenticate,
  onSubmit,
}: WorkerRegistrationDialogProps) {
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [reason, setReason] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const validId = /^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(id);
  const beginReview = async () => {
    setBusy(true);
    setError(null);
    try {
      await reauthenticate();
      setReviewing(true);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Reauthentication failed.",
      );
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ id, label: label.trim(), reason: reason.trim() });
      onOpenChange(false);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Worker registration failed.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register worker</DialogTitle>
          <DialogDescription>
            Create a fleet identity and receive its one-time key after
            confirmation.
          </DialogDescription>
        </DialogHeader>
        {reviewing ? (
          <div className="space-y-2 rounded-lg border bg-muted/30 p-4 text-sm">
            <p>
              <strong>ID:</strong> <span className="font-mono">{id}</span>
            </p>
            <p>
              <strong>Label:</strong> {label}
            </p>
            <p>
              <strong>Reason:</strong> {reason}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="worker-id">Worker ID</Label>
              <Input
                id="worker-id"
                value={id}
                onChange={(event) => setId(event.target.value.toLowerCase())}
                placeholder="z440-studio"
              />
              <p className="text-xs text-muted-foreground">
                Lowercase letters, numbers and hyphens; maximum 63 characters.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="worker-label">Label</Label>
              <Input
                id="worker-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Studio Z440"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="worker-reason">Reason</Label>
              <Textarea
                id="worker-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={500}
              />
            </div>
          </div>
        )}
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {reviewing ? (
            <Button disabled={busy} onClick={() => void submit()}>
              Confirm registration
            </Button>
          ) : (
            <Button
              disabled={busy || !validId || !label.trim() || !reason.trim()}
              onClick={() => void beginReview()}
            >
              Reauthenticate and review
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
