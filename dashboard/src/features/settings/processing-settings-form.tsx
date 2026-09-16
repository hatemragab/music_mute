import type { ProcessingSettings } from "@/api/contracts";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

export type ProcessingSettingsDraft = Omit<
  ProcessingSettings,
  "revision" | "updatedAt"
>;

export const validateProcessingSettings = (value: ProcessingSettingsDraft) => {
  const errors: string[] = [];
  if (
    !Number.isInteger(value.maxInputBytesExclusive) ||
    value.maxInputBytesExclusive < 2 ||
    value.maxInputBytesExclusive > 30_000_000
  )
    errors.push("Input bytes must be an integer from 2 through 30,000,000.");
  if (
    !Number.isFinite(value.maxDurationSecondsExclusive) ||
    value.maxDurationSecondsExclusive <= 0 ||
    value.maxDurationSecondsExclusive > 600
  )
    errors.push("Duration must be greater than 0 and at most 600 seconds.");
  if (
    value.maxActiveJobsPerUser !== null &&
    (!Number.isInteger(value.maxActiveJobsPerUser) ||
      value.maxActiveJobsPerUser < 1 ||
      value.maxActiveJobsPerUser > 100)
  )
    errors.push(
      "Active jobs must be Unlimited or an integer from 1 through 100.",
    );
  if (!value.acceptNewJobs && !value.maintenanceMessageEn.trim())
    errors.push(
      "An English maintenance message is required while admissions are paused.",
    );
  return errors;
};

export function ProcessingSettingsForm({
  value,
  onChange,
  disabled,
}: {
  value: ProcessingSettingsDraft;
  onChange(value: ProcessingSettingsDraft): void;
  disabled?: boolean;
}) {
  const errors = validateProcessingSettings(value);
  return (
    <fieldset disabled={disabled} className="space-y-6">
      <div className="flex items-start justify-between gap-4 rounded-xl border p-4">
        <div>
          <Label htmlFor="accept-new-jobs" className="font-medium">
            Accept new jobs
          </Label>
          <p className="mt-1 text-sm text-muted-foreground">
            Pausing blocks new reservations. Already accepted jobs continue and
            results remain available.
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
        <div className="space-y-2">
          <Label htmlFor="input-bytes">Maximum input bytes, exclusive</Label>
          <Input
            id="input-bytes"
            type="number"
            min="2"
            max="30000000"
            step="1"
            value={value.maxInputBytesExclusive}
            onChange={(event) =>
              onChange({
                ...value,
                maxInputBytesExclusive: Number(event.target.value),
              })
            }
          />
          <p className="text-xs text-muted-foreground">
            Files must be smaller than this exact byte value. Server capability
            maximum: 30,000,000.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="duration-seconds">
            Maximum duration seconds, exclusive
          </Label>
          <Input
            id="duration-seconds"
            type="number"
            min="0.001"
            max="600"
            step="0.1"
            value={value.maxDurationSecondsExclusive}
            onChange={(event) =>
              onChange({
                ...value,
                maxDurationSecondsExclusive: Number(event.target.value),
              })
            }
          />
          <p className="text-xs text-muted-foreground">
            Audio must be shorter than this value. Supported maximum: 600
            seconds.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="active-jobs">Maximum active jobs per user</Label>
          <Input
            id="active-jobs"
            type="number"
            min="1"
            max="100"
            step="1"
            value={value.maxActiveJobsPerUser ?? ""}
            placeholder="Unlimited"
            onChange={(event) =>
              onChange({
                ...value,
                maxActiveJobsPerUser:
                  event.target.value === "" ? null : Number(event.target.value),
              })
            }
          />
          <p className="text-xs text-muted-foreground">
            Leave empty for Unlimited. Empty submits null, never zero.
          </p>
        </div>
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
