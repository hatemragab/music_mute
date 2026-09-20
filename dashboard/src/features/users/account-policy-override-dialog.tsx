import { useState } from "react";
import type { AccountPolicyOverride } from "@/api/contracts";
import { ReasonDialog } from "@/components/reason-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { validateAccountPolicyOverride } from "./processing-access-validation";

type OverrideValues = AccountPolicyOverride["values"];
type OverrideKey = keyof OverrideValues;

const fields: Array<{
  key: OverrideKey;
  label: string;
  help: string;
  max?: number;
}> = [
  {
    key: "monthlyProcessingSeconds",
    label: "Successful processing seconds / UTC month",
    help: "7,200 seconds equals 120 minutes.",
  },
  {
    key: "maxDurationSeconds",
    label: "Maximum audio duration seconds",
    help: "Inclusive prepared-audio duration limit.",
  },
  {
    key: "maxPreparedAudioBytes",
    label: "Maximum prepared audio bytes",
    help: "Decimal bytes; 50,000,000 is the launch default.",
  },
  {
    key: "dailyUploadGrants",
    label: "Upload grants / UTC day",
    help: "New signed upload grants, not retries of the same valid request.",
  },
  {
    key: "monthlyUploadGrants",
    label: "Upload grants / UTC month",
    help: "Must be at least the daily grant limit.",
  },
  {
    key: "monthlyConfirmedUploadBytes",
    label: "Confirmed upload bytes / UTC month",
    help: "Counted after exact uploaded-object verification.",
  },
  {
    key: "maxClientInputAttempts",
    label: "Input attempts / logical audio",
    help: "Total newly issued attempts, including the first.",
  },
  {
    key: "monthlyDownloadGrants",
    label: "Result grants / UTC month",
    help: "Locally cached playback does not consume another grant.",
  },
  {
    key: "monthlyEstimatedDownloadBytes",
    label: "Estimated result bytes / UTC month",
    help: "Charges the immutable result size when a new grant is issued.",
  },
  {
    key: "maxRetainedOutputBytes",
    label: "Retained result bytes / account",
    help: "Successful outputs remain until job or account deletion.",
  },
  {
    key: "signedUrlTtlSeconds",
    label: "Signed URL validity seconds",
    help: "Cannot exceed 600 seconds.",
    max: 600,
  },
];

export function AccountPolicyOverrideDialog({
  open,
  onOpenChange,
  currentValues,
  currentOverride,
  currentExpiry,
  reauthenticate,
  onSave,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  currentValues: OverrideValues;
  currentOverride: OverrideValues;
  currentExpiry: string | null;
  reauthenticate(): Promise<void>;
  onSave(input: {
    values: OverrideValues;
    expiresAt: string | null;
    reason: string;
  }): Promise<void>;
}) {
  return open ? (
    <OverrideForm
      onOpenChange={onOpenChange}
      currentValues={currentValues}
      currentOverride={currentOverride}
      currentExpiry={currentExpiry}
      reauthenticate={reauthenticate}
      onSave={onSave}
    />
  ) : null;
}

function OverrideForm({
  onOpenChange,
  currentValues,
  currentOverride,
  currentExpiry,
  reauthenticate,
  onSave,
}: Omit<Parameters<typeof AccountPolicyOverrideDialog>[0], "open">) {
  const [draft, setDraft] = useState<Record<OverrideKey, string>>(
    () =>
      Object.fromEntries(
        fields.map(({ key }) => [key, currentOverride[key]?.toString() ?? ""]),
      ) as Record<OverrideKey, string>,
  );
  const [expiry, setExpiry] = useState(
    currentExpiry ? currentExpiry.slice(0, 16) : "",
  );
  const values = parseValues(draft);
  const errors = validateAccountPolicyOverride(values, currentValues, expiry);
  return (
    <ReasonDialog
      open
      onOpenChange={onOpenChange}
      title="Account policy override"
      description="Enter only values that should replace the global standard policy for this account. Blank fields continue using the global value."
      confirmLabel="Save override"
      freshAuth
      onReauthenticate={reauthenticate}
      summary={
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            {fields.map((field) => (
              <div key={field.key} className="space-y-2">
                <Label htmlFor={`override-${field.key}`}>{field.label}</Label>
                <Input
                  id={`override-${field.key}`}
                  type="number"
                  min={1}
                  max={field.max}
                  step="1"
                  value={draft[field.key]}
                  placeholder={`Global: ${currentValues[field.key] ?? "—"}`}
                  onChange={(event) =>
                    setDraft({ ...draft, [field.key]: event.target.value })
                  }
                />
                <p className="text-xs text-muted-foreground">{field.help}</p>
              </div>
            ))}
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
        const next = parseValues(draft);
        const currentErrors = validateAccountPolicyOverride(
          next,
          currentValues,
          expiry,
        );
        if (currentErrors.length) throw new Error(currentErrors.join(" "));
        await onSave({
          values: next,
          expiresAt: expiry ? new Date(expiry).toISOString() : null,
          reason,
        });
      }}
    />
  );
}

function parseValues(draft: Record<OverrideKey, string>): OverrideValues {
  return Object.fromEntries(
    fields.flatMap(({ key }) => {
      const raw = draft[key].trim();
      return raw ? [[key, Number(raw)]] : [];
    }),
  ) as OverrideValues;
}
