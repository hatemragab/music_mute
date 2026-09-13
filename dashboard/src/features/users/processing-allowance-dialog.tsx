import { useState } from "react";
import { ReasonDialog } from "@/components/reason-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { validateAllowance } from "./processing-access-validation";
export function ProcessingAllowanceDialog({
  open,
  onOpenChange,
  currentSeconds,
  reauthenticate,
  onSave,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  currentSeconds: number;
  reauthenticate(): Promise<void>;
  onSave(input: {
    allowanceAudioSeconds: number;
    expiresAt: string;
    reason: string;
  }): Promise<void>;
}) {
  return open ? (
    <AllowanceForm
      onOpenChange={onOpenChange}
      currentSeconds={currentSeconds}
      reauthenticate={reauthenticate}
      onSave={onSave}
    />
  ) : null;
}
function AllowanceForm({
  onOpenChange,
  currentSeconds,
  reauthenticate,
  onSave,
}: Omit<Parameters<typeof ProcessingAllowanceDialog>[0], "open">) {
  const [minutes, setMinutes] = useState(currentSeconds / 60);
  const [expiry, setExpiry] = useState("");
  const errors = validateAllowance(minutes, expiry);
  return (
    <ReasonDialog
      open
      onOpenChange={onOpenChange}
      title="Temporary processing allowance"
      description="This exception cannot bypass media duration, byte, global capacity or one-active-job limits. Revocation preserves accepted reservations."
      confirmLabel="Save allowance"
      freshAuth
      onReauthenticate={reauthenticate}
      summary={
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="allowance-minutes">
              Total allowance (audio minutes)
            </Label>
            <Input
              id="allowance-minutes"
              type="number"
              min={60}
              max={1440}
              step="any"
              value={Number.isFinite(minutes) ? minutes : ""}
              onChange={(event) =>
                setMinutes(
                  event.target.value === "" ? NaN : Number(event.target.value),
                )
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="allowance-expiry">Expires at (local time)</Label>
            <Input
              id="allowance-expiry"
              type="datetime-local"
              value={expiry}
              onChange={(event) => setExpiry(event.target.value)}
            />
          </div>
          <p>
            Current total: {currentSeconds / 60} min →{" "}
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
        const currentErrors = validateAllowance(minutes, expiry);
        if (currentErrors.length) throw new Error(currentErrors.join(" "));
        if (minutes * 60 < currentSeconds)
          throw new Error(
            "Use explicit revocation to remove an existing increase.",
          );
        await onSave({
          allowanceAudioSeconds: minutes * 60,
          expiresAt: new Date(expiry).toISOString(),
          reason,
        });
      }}
    />
  );
}
