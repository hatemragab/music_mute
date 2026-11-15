import type { UpdatePolicy } from "@/api/contracts";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
            aria-describedby="android-minimum-help"
            type="number"
            min="1"
            value={value.android.minimumBuild ?? ""}
            onChange={(event) =>
              onChange({
                ...value,
                android: {
                  ...value.android,
                  source: "google_play",
                  directReleaseId: null,
                  minimumBuild: nullableInteger(event.target.value),
                },
              })
            }
          />
          <p
            id="android-minimum-help"
            className="text-sm text-muted-foreground"
          >
            Builds below this version code must update from Google Play before
            they can continue. Builds at or above it may be offered the latest
            Play release. The app file stays in Play Console.
          </p>
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
                  source: "google_play",
                  directReleaseId: null,
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
