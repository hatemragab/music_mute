import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AccountRestrictionExpiryField({
  value,
  onChange,
}: {
  value: string;
  onChange(value: string): void;
}) {
  return (
    <div className="mt-3 space-y-2">
      <Label htmlFor="restriction-expiry">
        Optional restriction expiry (local time)
      </Label>
      <Input
        id="restriction-expiry"
        type="datetime-local"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <p className="text-xs text-muted-foreground">
        Empty means no automatic expiry. The server is authoritative; the
        dashboard does not remove restrictions from a local timer.
      </p>
    </div>
  );
}
