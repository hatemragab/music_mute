import type { AccountPolicyValues } from "@/api/contracts";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

export interface AccountPolicyDraft {
  acceptNewJobs: boolean;
  maintenanceMessageEn: string;
  maintenanceMessageAr: string | null;
  values: AccountPolicyValues;
}

const numericFields: Array<{
  key: keyof AccountPolicyValues;
  label: string;
  help: string;
  min?: number;
  max?: number;
}> = [
  {
    key: "monthlyProcessingSeconds",
    label: "Successful processing seconds / UTC month",
    help: "7,200 seconds equals 120 minutes. Only successful processing is consumed.",
  },
  {
    key: "maxDurationSeconds",
    label: "Maximum audio duration seconds",
    help: "Inclusive backend-owned media ceiling.",
  },
  {
    key: "maxPreparedAudioBytes",
    label: "Maximum prepared audio bytes",
    help: "Decimal bytes; the accepted launch default is 50,000,000.",
  },
  {
    key: "dailyUploadGrants",
    label: "Upload grants / UTC day",
    help: "Activated by the media-cost branch.",
  },
  {
    key: "monthlyUploadGrants",
    label: "Upload grants / UTC month",
    help: "Activated by the media-cost branch.",
  },
  {
    key: "monthlyConfirmedUploadBytes",
    label: "Confirmed upload bytes / UTC month",
    help: "Activated by the media-cost branch.",
  },
  {
    key: "maxWaitingJobs",
    label: "Maximum waiting jobs / account",
    help: "Activated by the queue branch.",
    min: 0,
  },
  {
    key: "maxProcessingJobs",
    label: "Maximum processing jobs / account",
    help: "Launch default is one.",
  },
  {
    key: "maxInfrastructureAttempts",
    label: "Infrastructure attempts / job",
    help: "Total attempts, including the first.",
  },
  {
    key: "maxClientInputAttempts",
    label: "Client/input attempts / logical audio",
    help: "Total attempts, including the first.",
  },
  {
    key: "monthlyDownloadGrants",
    label: "Download grants / UTC month",
    help: "Activated by the media-cost branch.",
  },
  {
    key: "monthlyEstimatedDownloadBytes",
    label: "Estimated download bytes / UTC month",
    help: "Activated by the media-cost branch.",
  },
  {
    key: "maxRetainedOutputBytes",
    label: "Retained successful output bytes / account",
    help: "Activated by the media-cost branch.",
  },
  {
    key: "signedUrlTtlSeconds",
    label: "Signed URL validity seconds",
    help: "Cannot exceed 600 seconds.",
    max: 600,
  },
  {
    key: "monthlyServiceOutboundBytes",
    label: "Service outbound safety bytes / UTC month",
    help: "Activated by the media-cost branch.",
  },
  {
    key: "deletionGraceHours",
    label: "Account deletion grace hours",
    help: "360 hours equals fifteen exact 24-hour periods.",
    min: 24,
  },
];

// Kept with the form so field labels and validation cannot drift.
// eslint-disable-next-line react-refresh/only-export-components
export const validateAccountPolicy = (value: AccountPolicyDraft) => {
  const errors: string[] = [];
  for (const field of numericFields) {
    const amount = value.values[field.key];
    if (
      !Number.isSafeInteger(amount) ||
      amount < (field.min ?? 1) ||
      (field.max !== undefined && amount > field.max)
    )
      errors.push(`${field.label} has an invalid value.`);
  }
  if (value.values.monthlyUploadGrants < value.values.dailyUploadGrants)
    errors.push("Monthly upload grants cannot be lower than daily grants.");
  if (
    value.values.monthlyEstimatedDownloadBytes >
    value.values.monthlyServiceOutboundBytes
  )
    errors.push(
      "The service outbound ceiling cannot be below the account download estimate.",
    );
  if (!value.acceptNewJobs && !value.maintenanceMessageEn.trim())
    errors.push(
      "An English maintenance message is required while admissions are paused.",
    );
  return errors;
};

export function AccountPolicyForm({
  value,
  onChange,
  disabled,
}: {
  value: AccountPolicyDraft;
  onChange(value: AccountPolicyDraft): void;
  disabled?: boolean;
}) {
  const errors = validateAccountPolicy(value);
  return (
    <fieldset disabled={disabled} className="space-y-6">
      <div className="flex items-start justify-between gap-4 rounded-xl border p-4">
        <div>
          <Label htmlFor="accept-new-jobs" className="font-medium">
            Accept new jobs
          </Label>
          <p className="mt-1 text-sm text-muted-foreground">
            Pausing blocks new reservations. Already accepted work keeps its
            policy snapshot.
          </p>
        </div>
        <Switch
          id="accept-new-jobs"
          checked={value.acceptNewJobs}
          onCheckedChange={(acceptNewJobs) =>
            onChange({ ...value, acceptNewJobs })
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {numericFields.map((field) => (
          <div key={field.key} className="space-y-2">
            <Label htmlFor={`policy-${field.key}`}>{field.label}</Label>
            <Input
              id={`policy-${field.key}`}
              type="number"
              min={field.min ?? 1}
              max={field.max}
              step="1"
              value={value.values[field.key]}
              onChange={(event) =>
                onChange({
                  ...value,
                  values: {
                    ...value.values,
                    [field.key]: Number(event.target.value),
                  },
                })
              }
            />
            <p className="text-xs text-muted-foreground">{field.help}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="maintenance-en">Maintenance message, English</Label>
          <Textarea
            id="maintenance-en"
            value={value.maintenanceMessageEn}
            onChange={(event) =>
              onChange({ ...value, maintenanceMessageEn: event.target.value })
            }
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="maintenance-ar">
            Maintenance message, Arabic (optional)
          </Label>
          <Textarea
            id="maintenance-ar"
            dir="rtl"
            value={value.maintenanceMessageAr ?? ""}
            onChange={(event) =>
              onChange({
                ...value,
                maintenanceMessageAr: event.target.value || null,
              })
            }
          />
        </div>
      </div>

      {errors.length ? (
        <ul className="space-y-1 text-sm text-destructive" role="alert">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
    </fieldset>
  );
}
