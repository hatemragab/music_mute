import { useState } from "react";
import { countries, countryCodes, countryName } from "./countries";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { AccountPolicyValues } from "@/api/contracts";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { LinkImportUserPicker } from "./link-import-user-picker";

export interface AccountPolicyDraft {
  linkImportEnabled: boolean;
  linkImportDisabledCountries: string[];
  linkImportDisabledUserIds: string[];
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
    help: "36,000 seconds equals 600 minutes. Only successful processing is consumed.",
  },
  {
    key: "maxDurationSeconds",
    label: "Maximum audio duration seconds",
    help: "Inclusive backend-owned media ceiling.",
  },
  {
    key: "maxPreparedAudioBytes",
    label: "Maximum prepared audio bytes",
    help: "Decimal bytes; 100,000,000 bytes equals 100 MB.",
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
  if (typeof value.linkImportEnabled !== "boolean")
    errors.push("Link import visibility must be a boolean.");
  const codes = value.linkImportDisabledCountries;
  if (
    codes.length > 250 ||
    new Set(codes).size !== codes.length ||
    codes.some((code) => !countryCodes.includes(code))
  )
    errors.push("Choose unique ISO country codes for link import visibility.");
  const userIds = value.linkImportDisabledUserIds;
  if (
    userIds.length > 1_000 ||
    new Set(userIds).size !== userIds.length ||
    userIds.some((id) => id.length !== 24 || !/^[a-f\d]{24}$/.test(id))
  )
    errors.push(
      "Choose up to 1,000 unique account IDs for link import visibility.",
    );
  return errors;
};

export function AccountPolicyForm({
  value,
  onChange,
  disabled,
  linkImportForcedOff = false,
  canReadUsers = false,
}: {
  value: AccountPolicyDraft;
  onChange(value: AccountPolicyDraft): void;
  disabled?: boolean;
  linkImportForcedOff?: boolean;
  canReadUsers?: boolean;
}) {
  const [countrySearch, setCountrySearch] = useState("");
  const matchingCountries = countries.filter(({ code, name }) =>
    `${name} ${code}`
      .toLowerCase()
      .includes(countrySearch.trim().toLowerCase()),
  );
  const errors = validateAccountPolicy(value);
  return (
    <fieldset className="space-y-6">
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
          disabled={disabled}
          onCheckedChange={(acceptNewJobs) =>
            onChange({ ...value, acceptNewJobs })
          }
        />
      </div>

      <section
        className="space-y-4 rounded-xl border p-4"
        aria-label="Native link import visibility"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <Label htmlFor="link-import-enabled">Show import from link</Label>
            <p className="mt-1 text-sm text-muted-foreground">
              File import stays available on Android, iOS, Mac, and Windows. Off
              hides their paste-link controls. Web and existing work are
              unaffected.
            </p>
          </div>
          <Switch
            id="link-import-enabled"
            checked={value.linkImportEnabled}
            disabled={disabled}
            onCheckedChange={(linkImportEnabled) =>
              onChange({ ...value, linkImportEnabled })
            }
          />
        </div>
        {linkImportForcedOff && (
          <p role="status" className="text-sm text-muted-foreground">
            The API process flag keeps native link import hidden, even when this
            switch is on.
          </p>
        )}
        <div className="space-y-2">
          <Label htmlFor="link-import-countries">
            Hide link import in these countries
          </Label>
          {!value.linkImportEnabled && (
            <p className="text-sm text-muted-foreground">
              Link import is hidden in all three native apps. Selected countries
              remain hidden after the switch is turned on.
            </p>
          )}
          <div className="flex flex-wrap gap-2" aria-label="Selected countries">
            {value.linkImportDisabledCountries.map((code) => (
              <Button
                key={code}
                type="button"
                variant="secondary"
                size="sm"
                aria-label={`Remove ${countryName(code)} (${code})`}
                disabled={disabled}
                onClick={() =>
                  onChange({
                    ...value,
                    linkImportDisabledCountries:
                      value.linkImportDisabledCountries.filter(
                        (selected) => selected !== code,
                      ),
                  })
                }
              >
                {countryName(code)} ({code}) ×
              </Button>
            ))}
          </div>
          <Input
            id="link-import-countries"
            placeholder="Search countries by name or code"
            value={countrySearch}
            disabled={disabled}
            onChange={(event) => setCountrySearch(event.target.value)}
          />
          <div
            className="max-h-48 overflow-y-auto rounded-lg border p-3"
            role="group"
            aria-label="Country choices"
          >
            {matchingCountries.map(({ code, name }) => (
              <label
                key={code}
                className="flex items-center gap-3 rounded p-2 hover:bg-muted/30"
              >
                <Checkbox
                  checked={value.linkImportDisabledCountries.includes(code)}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    onChange({
                      ...value,
                      linkImportDisabledCountries: (checked
                        ? [...value.linkImportDisabledCountries, code]
                        : value.linkImportDisabledCountries.filter(
                            (selected) => selected !== code,
                          )
                      ).sort(),
                    })
                  }
                />
                <span>
                  {name} ({code})
                </span>
              </label>
            ))}
            {!matchingCountries.length && (
              <p className="text-sm text-muted-foreground">
                No countries match.
              </p>
            )}
          </div>
        </div>
        <LinkImportUserPicker
          value={value.linkImportDisabledUserIds}
          onChange={(linkImportDisabledUserIds) =>
            onChange({ ...value, linkImportDisabledUserIds })
          }
          disabled={disabled}
          canReadUsers={canReadUsers}
        />
      </section>

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
              disabled={disabled}
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
            disabled={disabled}
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
            disabled={disabled}
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
