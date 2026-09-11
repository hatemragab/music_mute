import type { HealthSnapshot } from "@/api/contracts";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime, titleCase } from "@/lib/format";

export function HealthComponentCards({
  components,
}: {
  components: HealthSnapshot["components"];
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {components.map((component) => (
        <Card key={component.name}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-3">
              <CardTitle className="text-sm">
                {titleCase(component.name)}
              </CardTitle>
              <StatusBadge
                value={component.checkedAt ? component.status : "unknown"}
                label={component.checkedAt ? undefined : "Not checked"}
              />
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              Checked {formatDateTime(component.checkedAt)}
            </p>
            {component.code ? (
              <p className="mt-2 font-mono text-xs text-muted-foreground">
                {component.code}
              </p>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
