import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { StatusBadge } from "@/components/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface PolicyPreviewResult {
  currentRevision: number;
  valid: boolean;
  errors: string[];
  examples: Array<{
    platform: string;
    distribution: string;
    installedBuild: number;
    decision: string;
    targetBuild: number | null;
  }>;
}

export function PolicyPreview({ result }: { result: PolicyPreviewResult }) {
  return (
    <div className="space-y-4">
      <Alert variant={result.valid ? "default" : "destructive"}>
        <AlertTitle>
          {result.valid ? "Policy is valid" : "Policy needs changes"}
        </AlertTitle>
        <AlertDescription>
          {result.valid
            ? `Validated against current revision ${result.currentRevision}.`
            : result.errors.join(" ")}
        </AlertDescription>
      </Alert>
      {result.examples.length ? (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Platform</TableHead>
                <TableHead>Distribution</TableHead>
                <TableHead>Installed build</TableHead>
                <TableHead>Decision</TableHead>
                <TableHead>Target</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.examples.map((example, index) => (
                <TableRow
                  key={`${example.platform}-${example.distribution}-${example.installedBuild}-${index}`}
                >
                  <TableCell className="capitalize">
                    {example.platform}
                  </TableCell>
                  <TableCell>{example.distribution}</TableCell>
                  <TableCell>{example.installedBuild}</TableCell>
                  <TableCell>
                    <StatusBadge value={example.decision} />
                  </TableCell>
                  <TableCell>{example.targetBuild ?? "None"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </div>
  );
}
