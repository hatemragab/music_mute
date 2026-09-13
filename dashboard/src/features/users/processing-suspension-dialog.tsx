import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
export { ReasonDialog as ProcessingSuspensionDialog } from "@/components/reason-dialog";

export function SuspensionExpiryField({
  value,
  onChange,
}: {
  value: string;
  onChange(value: string): void;
}) {
  return (
    <div className="mt-3 space-y-2">
      <Label htmlFor="suspension-expiry">
        Optional suspension expiry (local time)
      </Label>
      <Input
        id="suspension-expiry"
        type="datetime-local"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <p className="text-xs text-muted-foreground">
        Empty means no automatic expiry. The server decides effective access;
        the dashboard never resumes processing from a local timer.
      </p>
    </div>
  );
}
