import { useState } from "react";

import type { WorkerDetail } from "@/api/contracts";
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

export interface RecoveryEvidence {
  stoppedAt: string;
  stopEvidence: string;
  reason: string;
}

interface WorkerRecoveryDialogProps {
  worker: WorkerDetail;
  open: boolean;
  onOpenChange(open: boolean): void;
  reauthenticate(): Promise<void>;
  onSubmit(input: RecoveryEvidence): Promise<void>;
}

export function WorkerRecoveryDialog(props: WorkerRecoveryDialogProps) {
  return props.open ? <OpenWorkerRecoveryDialog {...props} /> : null;
}

function OpenWorkerRecoveryDialog({
  worker,
  open,
  onOpenChange,
  reauthenticate,
  onSubmit,
}: WorkerRecoveryDialogProps) {
  const [stoppedAt, setStoppedAt] = useState("");
  const [evidence, setEvidence] = useState("");
  const [reason, setReason] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const assignment = worker.assignment;
  const canReview = Boolean(
    assignment && stoppedAt && evidence.trim().length >= 20 && reason.trim(),
  );
  const review = async () => {
    setBusy(true);
    setError(null);
    try {
      await reauthenticate();
      setReviewed(true);
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
      await onSubmit({
        stoppedAt: new Date(stoppedAt).toISOString(),
        stopEvidence: evidence.trim(),
        reason: reason.trim(),
      });
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Recovery failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Release confirmed stopped work</DialogTitle>
          <DialogDescription>
            This does not stop a remote process. Submit only after independently
            verifying the assigned process is stopped.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid gap-2 rounded-lg border bg-muted/30 p-3 text-xs">
          <div>
            <dt className="text-muted-foreground">Job</dt>
            <dd className="font-mono">
              {assignment?.jobId ?? "No assignment"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Attempt / session</dt>
            <dd className="font-mono break-all">
              {assignment?.attemptId} / {assignment?.sessionId}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Generation</dt>
            <dd>{assignment?.generation ?? "—"}</dd>
          </div>
        </dl>
        {!reviewed ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="stopped-at">Observed stopped time</Label>
              <Input
                id="stopped-at"
                type="datetime-local"
                value={stoppedAt}
                onChange={(event) => setStoppedAt(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="stop-evidence">Detailed stop evidence</Label>
              <Textarea
                id="stop-evidence"
                value={evidence}
                onChange={(event) => setEvidence(event.target.value)}
                placeholder="Describe the process/PID check and how termination was confirmed"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="recovery-reason">Reason</Label>
              <Textarea
                id="recovery-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
            <strong>Final acknowledgment:</strong> releasing this exact
            assignment allows replacement processing. It does not prove or kill
            a process by itself.
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
          {reviewed ? (
            <Button disabled={busy} onClick={() => void submit()}>
              Acknowledge and release
            </Button>
          ) : (
            <Button disabled={busy || !canReview} onClick={() => void review()}>
              Reauthenticate and review
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
