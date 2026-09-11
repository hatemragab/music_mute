import type { AlertRecord } from "@/api/contracts";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";

export function AlertsTable({
  alerts,
  canManage,
  onInspect,
  onAcknowledge,
}: {
  alerts: AlertRecord[];
  canManage: boolean;
  onInspect(alert: AlertRecord): void;
  onAcknowledge(alert: AlertRecord): void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Alert</TableHead>
          <TableHead>Severity</TableHead>
          <TableHead>State</TableHead>
          <TableHead>Last observed</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {alerts.map((alert) => (
          <TableRow key={alert.id}>
            <TableCell>
              <button
                className="cursor-pointer text-left font-medium text-primary hover:underline"
                onClick={() => onInspect(alert)}
              >
                {alert.type}
              </button>
              <p className="max-w-lg truncate text-xs text-muted-foreground">
                {alert.message}
              </p>
            </TableCell>
            <TableCell>
              <StatusBadge value={alert.severity} />
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1">
                <StatusBadge value={alert.state} />
                {alert.acknowledgedAt ? (
                  <StatusBadge value="active" label="Acknowledged" />
                ) : null}
              </div>
            </TableCell>
            <TableCell>{formatDateTime(alert.lastSeenAt)}</TableCell>
            <TableCell className="text-right">
              {canManage &&
              alert.state === "active" &&
              !alert.acknowledgedAt ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onAcknowledge(alert)}
                >
                  Acknowledge
                </Button>
              ) : null}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
