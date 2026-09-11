import { useRef, useState } from "react";
import { Download } from "lucide-react";

import { ApiError } from "@/api/api-client";
import { downloadCsv } from "@/api/csv-download";
import { useApiClient } from "@/auth/admin-session";
import { Button } from "@/components/ui/button";

export function ExportCsvButton({
  path,
  filename,
  label = "Export CSV",
}: {
  path: string;
  filename: string;
  label?: string;
}) {
  const client = useApiClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const download = async () => {
    controller.current?.abort();
    controller.current = new AbortController();
    setBusy(true);
    setError(null);
    try {
      await downloadCsv(client, path, filename, controller.current.signal);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code === "EXPORT_TOO_LARGE"
          ? "The export exceeds 10,000 rows. Narrow the current filters and try again."
          : caught instanceof Error
            ? caught.message
            : "Export failed.",
      );
    } finally {
      setBusy(false);
      controller.current = null;
    }
  };
  return (
    <div className="inline-flex flex-col items-end gap-1">
      <Button variant="outline" disabled={busy} onClick={() => void download()}>
        <Download aria-hidden="true" />
        {busy ? "Downloading…" : label}
      </Button>
      {error ? (
        <span
          className="max-w-sm text-right text-xs text-destructive"
          role="alert"
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}
