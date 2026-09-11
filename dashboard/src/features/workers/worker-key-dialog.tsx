import { useState } from "react";
import { Check, Copy, KeyRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

interface WorkerKeyDialogProps {
  value: string | null;
  workerId: string | null;
  onClear(): void;
}

export function WorkerKeyDialog(props: WorkerKeyDialogProps) {
  return props.value ? (
    <OpenWorkerKeyDialog
      value={props.value}
      workerId={props.workerId}
      onClear={props.onClear}
    />
  ) : null;
}

function OpenWorkerKeyDialog({
  value,
  workerId,
  onClear,
}: {
  value: string;
  workerId: string | null;
  onClear(): void;
}) {
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && acknowledged) onClear();
      }}
    >
      <DialogContent
        onEscapeKeyDown={(event) => {
          if (!acknowledged) event.preventDefault();
        }}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <KeyRound aria-hidden="true" className="size-5" />
          </div>
          <DialogTitle>Save this worker key now</DialogTitle>
          <DialogDescription>
            The raw key for {workerId} is shown once. It cannot be recovered
            from operation history.
          </DialogDescription>
        </DialogHeader>
        <div
          className="rounded-lg border bg-muted/30 p-3 font-mono text-sm break-all"
          data-sensitive="worker-key"
        >
          {value}
        </div>
        <Button
          variant="outline"
          onClick={async () => {
            if (value) {
              await navigator.clipboard.writeText(value);
              setCopied(true);
            }
          }}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{" "}
          {copied ? "Copied" : "Copy key"}
        </Button>
        <div className="flex items-start gap-3 rounded-lg border p-3">
          <Checkbox
            id="key-saved"
            checked={acknowledged}
            onCheckedChange={(value) => setAcknowledged(value === true)}
          />
          <Label htmlFor="key-saved" className="leading-relaxed">
            I saved this key securely and understand that closing clears it
            permanently.
          </Label>
        </div>
        <DialogFooter>
          <Button disabled={!acknowledged} onClick={onClear}>
            Close and clear key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
