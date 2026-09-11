import { useState } from "react";

import { ADMIN_ROLES, type AdminRole } from "@/api/contracts";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ROLE_DETAILS } from "./role-permissions";

interface AdminAccessFormProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  reauthenticate(): Promise<void>;
  onSubmit(input: {
    verifiedEmail: string;
    role: AdminRole;
    reason: string;
  }): Promise<void>;
}

export function AdminAccessForm(props: AdminAccessFormProps) {
  return props.open ? <OpenAdminAccessForm {...props} /> : null;
}

function OpenAdminAccessForm({
  open,
  onOpenChange,
  reauthenticate,
  onSubmit,
}: AdminAccessFormProps) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AdminRole>("viewer");
  const [reason, setReason] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const review = async () => {
    if (!email.trim() || !reason.trim()) return;
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
      await onSubmit({
        verifiedEmail: email.trim().toLowerCase(),
        role,
        reason: reason.trim(),
      });
      onOpenChange(false);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The administrator could not be added.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add administrator</DialogTitle>
          <DialogDescription>
            The account must already exist as a verified Google identity. The
            backend performs directory verification.
          </DialogDescription>
        </DialogHeader>
        {reviewing ? (
          <div className="space-y-3 rounded-lg border bg-muted/30 p-4 text-sm">
            <p>
              <strong>Account:</strong> {email}
            </p>
            <p>
              <strong>Role:</strong> {ROLE_DETAILS[role].label}
            </p>
            <p>
              <strong>Impact:</strong> {ROLE_DETAILS[role].description}
            </p>
            <p>
              <strong>Reason:</strong> {reason}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="admin-email">Verified Google email</Label>
              <Input
                id="admin-email"
                type="email"
                autoComplete="off"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="admin-role">Role</Label>
              <Select
                value={role}
                onValueChange={(value) => setRole(value as AdminRole)}
              >
                <SelectTrigger id="admin-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ADMIN_ROLES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {ROLE_DETAILS[value].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {ROLE_DETAILS[role].description}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="admin-add-reason">Reason</Label>
              <Textarea
                id="admin-add-reason"
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
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
              Confirm administrator
            </Button>
          ) : (
            <Button
              disabled={busy || !email.trim() || !reason.trim()}
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
