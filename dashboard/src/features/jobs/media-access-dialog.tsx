import { useState } from "react";

import type { MediaGrant } from "@/api/contracts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface MediaAccessDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  asset: "input" | "result";
  action: "play" | "download";
  reauthenticate(): Promise<void>;
  requestGrant(reason: string): Promise<MediaGrant>;
  onGranted(grant: MediaGrant): void;
}

export function MediaAccessDialog(props: MediaAccessDialogProps) {
  return props.open ? <OpenMediaAccessDialog {...props} /> : null;
}

function OpenMediaAccessDialog({
  open,
  onOpenChange,
  asset,
  action,
  reauthenticate,
  requestGrant,
  onGranted,
}: MediaAccessDialogProps) {
  const [reason, setReason] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const grant = async () => {
    setBusy(true);
    setError(null);
    try {
      onGranted(await requestGrant(reason.trim()));
      onOpenChange(false);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Media access failed.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {action === "play" ? "Play" : "Download"}{" "}
            {asset === "input" ? "input audio" : "vocals result"}
          </DialogTitle>
          <DialogDescription>
            A private five-minute grant is created only after confirmation.
            Grant issuance is audited.
          </DialogDescription>
        </DialogHeader>
        {reviewed ? (
          <div className="rounded-lg border bg-muted/30 p-4 text-sm">
            Confirm {action} access for the {asset} asset. Firebase credentials
            are never sent to the media host.
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="media-reason">Reason</Label>
            <Textarea
              id="media-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
            />
          </div>
        )}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {reviewed ? (
            <Button disabled={busy} onClick={() => void grant()}>
              Confirm {action}
            </Button>
          ) : (
            <Button
              disabled={busy || !reason.trim()}
              onClick={() => void review()}
            >
              Reauthenticate and review
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
