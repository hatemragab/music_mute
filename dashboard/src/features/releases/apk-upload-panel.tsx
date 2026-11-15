import { useEffect, useRef, useState } from "react";
import { FileUp, X } from "lucide-react";

import { createOperationId } from "@/api/api-client";
import type { ReleaseDetail } from "@/api/contracts";
import { useApiClient } from "@/auth/admin-session";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { formatBytes } from "@/lib/format";
import { hashApk, uploadApk, validateApk } from "./apk-upload";
import {
  completeReleaseUpload,
  getReleaseUpload,
  reserveReleaseUpload,
} from "./releases-api";

type Phase =
  | "idle"
  | "hashing"
  | "uploading"
  | "verifying"
  | "verified"
  | "rejected"
  | "cancelled";

export function ApkUploadPanel({
  release,
  onComplete,
}: {
  release: ReleaseDetail;
  onComplete(): void;
}) {
  const client = useApiClient();
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );
  if (release.platform !== "android" || release.source !== "direct_apk")
    return null;
  const run = async () => {
    if (!file) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setError(null);
    try {
      validateApk(file);
      setPhase("hashing");
      setProgress(0);
      const sha256Hex = await hashApk(file, setProgress, controller.signal);
      const reservation = await reserveReleaseUpload(client, release.id, {
        bytes: file.size,
        sha256Hex,
        expectedRevision: release.revision,
        operationId: createOperationId(),
      });
      setPhase("uploading");
      setProgress(0);
      await uploadApk(reservation.grant, file, setProgress, controller.signal);
      setPhase("verifying");
      setProgress(1);
      let status = await completeReleaseUpload(
        client,
        release.id,
        reservation.uploadId,
      );
      const deadline = Date.now() + 120_000;
      while (
        !["verified", "rejected"].includes(status.artifactState) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => window.setTimeout(resolve, 2_000));
        if (controller.signal.aborted)
          throw new DOMException("Upload cancelled.", "AbortError");
        status = await getReleaseUpload(
          client,
          release.id,
          reservation.uploadId,
        );
      }
      if (status.artifactState === "verified") {
        setPhase("verified");
        onComplete();
      } else {
        setPhase("rejected");
        setError(
          status.code || "Verification did not complete within 120 seconds.",
        );
      }
    } catch (caught) {
      if ((caught as DOMException).name === "AbortError") setPhase("cancelled");
      else {
        setPhase("rejected");
        setError(
          caught instanceof Error ? caught.message : "APK upload failed.",
        );
      }
    } finally {
      controllerRef.current = null;
    }
  };
  return (
    <div className="space-y-4 rounded-xl border p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-medium">Direct APK artifact</h3>
          <p className="text-sm text-muted-foreground">
            SHA-256 is computed in bounded worker chunks before private upload.
          </p>
        </div>
        <StatusBadge value={release.artifactState || phase} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="apk-file">APK file</Label>
        <input
          id="apk-file"
          type="file"
          className="block w-full min-w-0 text-sm"
          accept=".apk,application/vnd.android.package-archive"
          onChange={(event) => {
            const selected = event.target.files?.[0] ?? null;
            setFile(selected);
            setPhase("idle");
            setError(null);
            if (selected) {
              try {
                validateApk(selected);
              } catch (caught) {
                setError(
                  caught instanceof Error ? caught.message : "Invalid APK.",
                );
              }
            }
          }}
        />
      </div>
      {file ? (
        <p className="text-sm">
          <span className="font-medium">{file.name}</span> ·{" "}
          {formatBytes(file.size)}
        </p>
      ) : null}
      {phase !== "idle" ? (
        <div className="space-y-2">
          <div className="flex justify-between text-xs capitalize">
            <span>{phase}</span>
            <span>{Math.round(progress * 100)}%</span>
          </div>
          <Progress value={progress * 100} />
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          disabled={
            !file ||
            Boolean(error) ||
            !["idle", "cancelled", "rejected"].includes(phase)
          }
          onClick={() => void run()}
        >
          <FileUp aria-hidden="true" /> Hash and upload
        </Button>
        {["hashing", "uploading", "verifying"].includes(phase) ? (
          <Button
            variant="outline"
            onClick={() => controllerRef.current?.abort()}
          >
            <X aria-hidden="true" /> Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}
