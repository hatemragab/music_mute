import { useEffect, useRef, useState } from "react";
import { FileUp, X } from "lucide-react";

import {
  ApiError,
  createOperationId,
  OperationOutcomeUnknownError,
} from "@/api/api-client";
import type { OperationReceipt } from "@/api/contracts";
import { useAdminSession, useApiClient } from "@/auth/admin-session";
import { InlineBusy } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { formatBytes } from "@/lib/format";
import {
  completeMacosUpload,
  createMacosDraft,
  getMacosRelease,
  reserveMacosUpload,
  type MacosDraftInput,
  type MacosRelease,
  type MacosUpdateConfiguration,
} from "./macos-updates-api";
import {
  hashDmg,
  readSignedAppcast,
  uploadDmg,
  validateDmg,
} from "./macos-upload";

interface UploadSession {
  input: MacosDraftInput;
  file: File;
  release: MacosRelease | null;
  completionOperationId: string | null;
  resumeReleaseId?: string;
  expectedUploadRevision?: number;
}

export function MacosUploadPanel({
  config,
  onChange,
  existingRelease,
  onReset,
  onUnresolved,
  onBusy,
}: {
  config: MacosUpdateConfiguration;
  onChange(release?: MacosRelease): Promise<void>;
  existingRelease?: MacosRelease;
  onReset?(): void;
  onUnresolved?(unresolved: boolean): void;
  onBusy?(busy: boolean): void;
}) {
  const client = useApiClient();
  const { reauthenticate } = useAdminSession();
  const [file, setFile] = useState<File | null>(null);
  const [appcast, setAppcast] = useState<File | null>(null);
  const [reason, setReason] = useState("");
  const [phase, setPhase] = useState("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [upload, setUpload] = useState<UploadSession | null>(null);
  const [unknownOperationId, setUnknownOperationId] = useState<string | null>(
    null,
  );
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => controllerRef.current?.abort(), []);
  const busy = [
    "reading",
    "authenticating",
    "hashing",
    "creating",
    "uploading",
    "verifying",
    "checking",
  ].includes(phase);
  useEffect(() => {
    onBusy?.(busy);
  }, [busy, onBusy]);
  const [completionRetryAllowed, setCompletionRetryAllowed] = useState(false);

  const fail = (caught: unknown) => {
    setPhase("paused");
    setError(
      caught instanceof Error
        ? caught.message
        : "The update could not be uploaded.",
    );
    if (caught instanceof OperationOutcomeUnknownError) {
      setUnknownOperationId(caught.operationId);
      onUnresolved?.(true);
    } else if (caught instanceof ApiError && caught.status < 500) {
      setUpload((current) =>
        current?.release ? { ...current, completionOperationId: null } : null,
      );
    }
  };

  const verify = async (session: UploadSession) => {
    if (!session.release) return;
    const operationId = session.completionOperationId ?? createOperationId();
    const next = { ...session, completionOperationId: operationId };
    setUpload(next);
    setPhase("authenticating");
    await reauthenticate();
    setPhase("verifying");
    setCompletionRetryAllowed(false);
    const verified = await completeMacosUpload(
      client,
      session.release.id,
      operationId,
    );
    setUpload({ ...next, release: verified });
    if (verified.artifactState !== "verified")
      throw new Error(
        "The draft has not been verified. Check its committed state before uploading again.",
      );
    setPhase("verified");
    setProgress(1);
    setError(null);
    onUnresolved?.(false);
    await onChange(verified);
  };

  const transfer = async (
    session: UploadSession,
    controller: AbortController,
  ) => {
    setPhase("authenticating");
    await reauthenticate();
    if (controller.signal.aborted)
      throw new DOMException("Upload cancelled.", "AbortError");
    setPhase("creating");
    const result = session.resumeReleaseId
      ? await reserveMacosUpload(client, session.resumeReleaseId, {
          expectedRevision:
            session.expectedUploadRevision ?? session.release!.revision,
          operationId: session.input.operationId,
          reason: session.input.reason,
        })
      : await createMacosDraft(client, session.input);
    const next = { ...session, release: result.release };
    setUpload(next);
    await onChange(result.release);
    if (
      result.release.archiveName !== session.file.name ||
      result.release.bytes !== session.file.size ||
      result.release.sha256Hex !== session.input.sha256Hex
    )
      throw new Error("The draft does not match the selected DMG.");
    if (result.release.artifactState === "verified") {
      setPhase("verified");
      return;
    }
    if (!result.grant) {
      setPhase("paused");
      setError(
        "The draft was created, but its upload grant response was lost. Recover the grant to continue this same draft.",
      );
      return;
    }
    setPhase("uploading");
    setProgress(0);
    await uploadDmg(
      result.grant,
      session.file,
      controller.signal,
      session.input.sha256Hex,
    );
    setProgress(1);
    await verify(next);
  };

  const run = async (recover = false) => {
    if (controllerRef.current) return;
    if (!recover && (!file || (!existingRelease && !appcast) || !reason.trim()))
      return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setError(null);
    setPhase(recover ? "authenticating" : "reading");
    try {
      if (recover && upload) {
        await transfer(upload, controller);
      } else {
        validateDmg(file!);
        const parsed = existingRelease
          ? { appcastBase64: "", expectedSha256Hex: existingRelease.sha256Hex }
          : await readSignedAppcast(appcast!, file!, config.downloadBaseUrl);
        if (
          existingRelease &&
          (existingRelease.archiveName !== file!.name ||
            existingRelease.bytes !== file!.size)
        )
          throw new Error(
            "Select the same prepared DMG with the draft's filename and byte size.",
          );
        setPhase("hashing");
        setProgress(0);
        const sha256Hex = await hashDmg(file!, setProgress, controller.signal);
        if (sha256Hex !== parsed.expectedSha256Hex)
          throw new Error(
            "The DMG SHA-256 does not match its canonical filename. Prepare the signed update again.",
          );
        const session: UploadSession = {
          file: file!,
          release: existingRelease ?? null,
          completionOperationId: null,
          resumeReleaseId: existingRelease?.id,
          expectedUploadRevision: existingRelease?.revision,
          input: {
            appcastBase64: parsed.appcastBase64,
            archiveName: file!.name,
            bytes: file!.size,
            sha256Hex,
            operationId: createOperationId(),
            reason: reason.trim(),
          },
        };
        setUpload(session);
        await transfer(session, controller);
      }
    } catch (caught) {
      fail(caught);
    } finally {
      controllerRef.current = null;
    }
  };

  const checkOutcome = async () => {
    if (!unknownOperationId || !upload) return;
    setPhase("checking");
    try {
      const receipt = await client.get<OperationReceipt>(
        `/admin/operations/${encodeURIComponent(unknownOperationId)}`,
      );
      if (receipt.status === "pending")
        throw new Error(
          "The operation is still pending. Check its outcome again before continuing.",
        );
      if (receipt.status === "failed") {
        setUnknownOperationId(null);
        onUnresolved?.(false);
        if (unknownOperationId === upload.input.operationId) setUpload(null);
        else setUpload({ ...upload, completionOperationId: null });
        throw new Error(
          `The operation failed (${receipt.code ?? "OPERATION_FAILED"}).`,
        );
      }
      const release = await getMacosRelease(
        client,
        receipt.resourceId ?? upload.release?.id ?? "",
      );
      setUpload({ ...upload, release });
      setUnknownOperationId(null);
      onUnresolved?.(false);
      setPhase(release.artifactState === "verified" ? "verified" : "paused");
      setError(
        release.artifactState === "verified"
          ? null
          : "The draft is awaiting upload verification. Verify it or recover its upload grant.",
      );
      await onChange(release);
    } catch (caught) {
      if (
        caught instanceof ApiError &&
        caught.status === 404 &&
        upload.release &&
        upload.completionOperationId === unknownOperationId
      ) {
        try {
          const release = await getMacosRelease(client, upload.release.id);
          setUpload({ ...upload, release });
          await onChange(release);
          if (release.artifactState === "verified") {
            setUnknownOperationId(null);
            onUnresolved?.(false);
            setPhase("verified");
            setError(null);
          } else {
            setCompletionRetryAllowed(true);
            setPhase("paused");
            setError(
              "The receipt is not available and the draft is still awaiting verification. Check again after the server finishes, or explicitly retry verification with the same operation ID.",
            );
          }
          return;
        } catch (readError) {
          fail(readError);
          return;
        }
      }
      fail(caught);
    }
  };

  return (
    <section
      className="space-y-4 rounded-xl border bg-card p-5"
      aria-labelledby="macos-upload-title"
    >
      <div>
        <h2 id="macos-upload-title" className="font-semibold">
          {existingRelease
            ? `Resume ${existingRelease.versionName} (${existingRelease.buildNumber})`
            : "Upload signed update"}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {existingRelease
            ? "Select the same prepared DMG for this draft. Its signed appcast is already saved on the server."
            : "Select the matching DMG and signed appcast.xml from update preparation. Upload creates a draft; publication is a separate reviewed action."}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="macos-dmg">Prepared DMG</Label>
          <Input
            id="macos-dmg"
            type="file"
            accept=".dmg"
            disabled={busy || !!upload}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setError(null);
            }}
          />
        </div>
        {!existingRelease ? (
          <div className="space-y-2">
            <Label htmlFor="macos-appcast">Signed appcast.xml</Label>
            <Input
              id="macos-appcast"
              type="file"
              accept=".xml,application/xml"
              disabled={busy || !!upload}
              onChange={(event) => {
                setAppcast(event.target.files?.[0] ?? null);
                setError(null);
              }}
            />
          </div>
        ) : null}
      </div>
      {file ? (
        <p className="break-all text-sm">
          {file.name} · {formatBytes(file.size)}
        </p>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="macos-upload-reason">Upload reason</Label>
        <Textarea
          id="macos-upload-reason"
          value={reason}
          maxLength={500}
          disabled={busy || !!upload}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      {phase !== "idle" ? (
        <div className="space-y-2" role="status">
          <p className="text-sm capitalize">
            {phase === "uploading"
              ? "Uploading · awaiting storage acknowledgement"
              : phase === "verifying"
                ? "Verifying uploaded bytes and SHA-256 · this may take a few minutes"
                : phase}
            {phase === "hashing" ? ` · ${Math.round(progress * 100)}%` : ""}
          </p>
          {phase === "hashing" ? <Progress value={progress * 100} /> : null}
        </div>
      ) : null}
      {upload?.release ? (
        <p className="text-sm">
          Draft {upload.release.versionName} ({upload.release.buildNumber}) ·{" "}
          {upload.release.artifactState.replaceAll("_", " ")}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {!upload ? (
          <Button
            disabled={
              busy ||
              !config.configured ||
              !file ||
              (!existingRelease && !appcast) ||
              !reason.trim()
            }
            onClick={() => void run()}
          >
            <FileUp aria-hidden="true" />
            {busy ? <InlineBusy label="Preparing update" /> : "Hash and upload"}
          </Button>
        ) : null}
        {unknownOperationId ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void checkOutcome()}
          >
            Check operation outcome
          </Button>
        ) : null}
        {unknownOperationId && upload && completionRetryAllowed && !busy ? (
          <Button
            variant="outline"
            onClick={() => {
              setUnknownOperationId(null);
              setError(null);
              void verify(upload).catch(fail);
            }}
          >
            Retry verification with same operation ID
          </Button>
        ) : null}
        {upload && !unknownOperationId && phase === "paused" ? (
          <>
            {upload.release ? (
              <Button
                variant="outline"
                onClick={() => {
                  setError(null);
                  void verify(upload).catch(fail);
                }}
              >
                Verify uploaded draft
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => void run(true)}>
              Recover upload grant and resume
            </Button>
          </>
        ) : null}
        {busy && !["verifying", "creating", "checking"].includes(phase) ? (
          <Button
            variant="outline"
            onClick={() => controllerRef.current?.abort()}
          >
            <X aria-hidden="true" />
            Cancel
          </Button>
        ) : null}
        {phase === "verified" ? (
          <Button
            variant="outline"
            onClick={() => {
              setUpload(null);
              setFile(null);
              setAppcast(null);
              setReason("");
              setPhase("idle");
              onReset?.();
            }}
          >
            Prepare another update
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Uploads are immutable. If a response is lost or cancelled, verify the
        existing draft before retrying. Recovery retains the same operation ID
        in this page session.
      </p>
    </section>
  );
}
