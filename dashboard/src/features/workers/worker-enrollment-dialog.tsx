import { useRef, useState } from "react";
import { Copy, KeyRound, Plus } from "lucide-react";

import { ApiError, createOperationId } from "@/api/api-client";
import { useAdminSession, useApiClient } from "@/auth/admin-session";
import { InlineBusy } from "@/components/page";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/format";
import { createWorkerInvitation } from "./worker-api";
import type { WorkerInvitationCredential } from "./worker-types";

export function WorkerEnrollmentDialog({
  onCreated,
  label = "Create invitation",
}: {
  onCreated(): Promise<void> | void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button ref={triggerRef} onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" /> {label}
      </Button>
      {open ? (
        <OpenWorkerEnrollmentDialog
          open
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) window.setTimeout(() => triggerRef.current?.focus(), 0);
          }}
          onCreated={onCreated}
        />
      ) : null}
    </>
  );
}

function OpenWorkerEnrollmentDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onCreated(): Promise<void> | void;
}) {
  const client = useApiClient();
  const { reauthenticate } = useAdminSession();
  const [expiresInSeconds, setExpiresInSeconds] = useState(900);
  const [reason, setReason] = useState("");
  const [reauthenticated, setReauthenticated] = useState(false);
  const [credential, setCredential] =
    useState<WorkerInvitationCredential | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const close = (next: boolean) => {
    if (!next) {
      setCredential(null);
      setCopied(false);
      setError(null);
    }
    onOpenChange(next);
  };

  const authenticate = async () => {
    setBusy(true);
    setError(null);
    try {
      await reauthenticate();
      setReauthenticated(true);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!reason.trim() || !reauthenticated) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createWorkerInvitation(client, {
        operationId: createOperationId(),
        expiresInSeconds,
        reason: reason.trim(),
      });
      if (!result.credential || !result.expiresAt)
        throw new Error(
          "The invitation was already created, but its one-use secret cannot be shown again. Revoke it and create a replacement.",
        );
      setCredential(result);
      await onCreated();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const apiError = error instanceof ApiError ? error : null;
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {credential ? "Save the one-use code" : "Enroll a worker machine"}
          </DialogTitle>
          <DialogDescription>
            {credential
              ? "This secret is shown once. It is cleared from this browser as soon as you close this dialog."
              : "Create a short-lived, single-use invitation for the native installer."}
          </DialogDescription>
        </DialogHeader>
        {credential ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
              <div className="flex items-center gap-2 font-medium">
                <KeyRound aria-hidden="true" className="size-4" /> One-use
                enrollment code
              </div>
              <pre
                className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-background p-3 text-xs"
                data-testid="worker-enrollment-credential"
              >
                {credential.credential}
              </pre>
              <p className="mt-2 text-xs text-muted-foreground">
                Expires {formatDateTime(credential.expiresAt)} · Invitation{" "}
                {credential.invitationId}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={async () => {
                await navigator.clipboard.writeText(credential.credential!);
                setCopied(true);
              }}
            >
              <Copy aria-hidden="true" /> {copied ? "Copied" : "Copy code"}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="worker-invitation-expiry">Expires after</Label>
              <Select
                value={String(expiresInSeconds)}
                onValueChange={(value) => setExpiresInSeconds(Number(value))}
              >
                <SelectTrigger id="worker-invitation-expiry">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="900">15 minutes</SelectItem>
                  <SelectItem value="3600">1 hour</SelectItem>
                  <SelectItem value="86400">24 hours</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="worker-invitation-reason">Reason</Label>
              <Textarea
                id="worker-invitation-reason"
                value={reason}
                maxLength={500}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Record why this machine is being enrolled"
              />
              <p className="text-xs text-muted-foreground">
                Required · {reason.length}/500
              </p>
            </div>
          </div>
        )}
        {error ? (
          <div className="text-sm text-destructive" role="alert">
            <p>
              {error instanceof Error
                ? error.message
                : "The invitation could not be created."}
            </p>
            {apiError?.requestId ? (
              <p className="font-mono text-xs">Request {apiError.requestId}</p>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          {credential ? (
            <Button onClick={() => close(false)}>I saved the code</Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => close(false)}
              >
                Cancel
              </Button>
              {!reauthenticated ? (
                <Button disabled={busy} onClick={() => void authenticate()}>
                  {busy ? <InlineBusy label="Verifying…" /> : "Verify identity"}
                </Button>
              ) : (
                <Button
                  disabled={busy || !reason.trim()}
                  onClick={() => void create()}
                >
                  {busy ? (
                    <InlineBusy label="Creating…" />
                  ) : (
                    "Create one-use code"
                  )}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
