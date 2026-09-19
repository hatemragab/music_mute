import { useState } from "react";
import { ReasonDialog } from "@/components/reason-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { validateAccountPolicyOverride } from "./processing-access-validation";

export function AccountPolicyOverrideDialog({
  open,
  onOpenChange,
  currentSeconds,
  currentExpiry,
  reauthenticate,
  onSave,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  currentSeconds: number;
  currentExpiry: string | null;
  reauthenticate(): Promise<void>;
  onSave(input: {
    monthlyProcessingSeconds: number;
    expiresAt: string | null;
    reason: string;
  }): Promise<void>;
}) {
  return open ? (
    <OverrideForm
      onOpenChange={onOpenChange}
      currentSeconds={currentSeconds}
      currentExpiry={currentExpiry}
      reauthenticate={reauthenticate}
      onSave={onSave}
    />
  ) : null;
}

function OverrideForm({
  onOpenChange,
  currentSeconds,
  currentExpiry,
  reauthenticate,
  onSave,
}: Omit<Parameters<typeof AccountPolicyOverrideDialog>[0], "open">) {
  const [minutes, setMinutes] = useState(currentSeconds / 60);
  const [expiry, setExpiry] = useState(
    currentExpiry ? currentExpiry.slice(0, 16) : "",
  );
  const errors = validateAccountPolicyOverride(minutes, expiry);
  return (
    <ReasonDialog
      open
      onOpenChange={onOpenChange}
      title="Account processing override"
      description="Replace this account's monthly processing limit. The value is not added to the global limit and never changes raw usage counters."
      confirmLabel="Save override"
      freshAuth
      onReauthenticate={reauthenticate}
      summary={
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="override-minutes">
              Monthly successful processing minutes
            </Label>
            <Input
              id="override-minutes"
              type="number"
              min={1 / 60}
              step={1 / 60}
              value={Number.isFinite(minutes) ? minutes : ""}
              onChange={(event) =>
                setMinutes(
                  event.target.value === "" ? NaN : Number(event.target.value),
                )
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="override-expiry">
              Expires at (optional local time)
            </Label>
            <Input
              id="override-expiry"
              type="datetime-local"
              value={expiry}
              onChange={(event) => setExpiry(event.target.value)}
            />
          </div>
          <p>
            Effective total: {currentSeconds / 60} min →{" "}
            {Number.isFinite(minutes) ? minutes : "—"} min
          </p>
          {errors.length ? (
            <ul className="list-inside list-disc text-xs text-muted-foreground">
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          ) : null}
        </div>
      }
      onConfirm={async (reason) => {
        const currentErrors = validateAccountPolicyOverride(minutes, expiry);
        if (currentErrors.length) throw new Error(currentErrors.join(" "));
        await onSave({
          monthlyProcessingSeconds: minutes * 60,
          expiresAt: expiry ? new Date(expiry).toISOString() : null,
          reason,
        });
      }}
    />
  );
}
