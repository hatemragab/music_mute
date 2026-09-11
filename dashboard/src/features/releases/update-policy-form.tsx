import type { UpdatePolicy } from "@/api/contracts";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const nullableInteger = (value: string) =>
  value === "" ? null : Number(value);

export function UpdatePolicyForm({
  value,
  onChange,
  disabled,
}: {
  value: UpdatePolicy;
  onChange(value: UpdatePolicy): void;
  disabled?: boolean;
}) {
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <fieldset disabled={disabled} className="space-y-4 rounded-xl border p-4">
        <legend className="px-2 font-semibold">Android</legend>
        <div className="space-y-2">
          <Label htmlFor="android-minimum">Minimum supported build</Label>
          <Input
            id="android-minimum"
            type="number"
            min="1"
            value={value.android.minimumBuild ?? ""}
            onChange={(event) =>
              onChange({
                ...value,
                android: {
                  ...value.android,
                  minimumBuild: nullableInteger(event.target.value),
                },
              })
            }
          />
        </div>
        <div className="space-y-2">
          <Label>Distribution source</Label>
          <Select
            value={value.android.source}
            onValueChange={(source) =>
              onChange({
                ...value,
                android: {
                  ...value.android,
                  source: source as UpdatePolicy["android"]["source"],
                },
              })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="direct_apk">Direct APK</SelectItem>
              <SelectItem value="google_play">Google Play</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="android-direct">Direct release ID</Label>
          <Input
            id="android-direct"
            value={value.android.directReleaseId ?? ""}
            onChange={(event) =>
              onChange({
                ...value,
                android: {
                  ...value.android,
                  directReleaseId: event.target.value || null,
                },
              })
            }
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="android-store">Play release ID</Label>
          <Input
            id="android-store"
            value={value.android.storeReleaseId ?? ""}
            onChange={(event) =>
              onChange({
                ...value,
                android: {
                  ...value.android,
                  storeReleaseId: event.target.value || null,
                },
              })
            }
          />
        </div>
      </fieldset>
      <fieldset disabled={disabled} className="space-y-4 rounded-xl border p-4">
        <legend className="px-2 font-semibold">iOS</legend>
        <div className="space-y-2">
          <Label htmlFor="ios-minimum">Minimum supported build</Label>
          <Input
            id="ios-minimum"
            type="number"
            min="1"
            value={value.ios.minimumBuild ?? ""}
            onChange={(event) =>
              onChange({
                ...value,
                ios: {
                  ...value.ios,
                  minimumBuild: nullableInteger(event.target.value),
                },
              })
            }
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="ios-store">App Store release ID</Label>
          <Input
            id="ios-store"
            value={value.ios.storeReleaseId ?? ""}
            onChange={(event) =>
              onChange({
                ...value,
                ios: {
                  ...value.ios,
                  storeReleaseId: event.target.value || null,
                },
              })
            }
          />
        </div>
        <p className="text-sm text-muted-foreground">
          Builds below the minimum are required to update. Supported builds may
          be offered the latest target.
        </p>
      </fieldset>
    </div>
  );
}
