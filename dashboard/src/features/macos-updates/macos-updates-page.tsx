import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Download, ShieldCheck } from "lucide-react";
import { useSearchParams } from "react-router";

import {
  ApiError,
  createOperationId,
  OperationOutcomeUnknownError,
} from "@/api/api-client";
import type { OperationReceipt } from "@/api/contracts";
import { useAdminSession, useApiClient } from "@/auth/admin-session";
import { CursorPagination } from "@/components/cursor-pagination";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from "@/components/page";
import { ReasonDialog } from "@/components/reason-dialog";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBytes, formatDateTime } from "@/lib/format";
import {
  changeMacosPublication,
  completeMacosUpload,
  configureMacosUpdates,
  getMacosConfiguration,
  getMacosRelease,
  listMacosReleases,
  publicMacosConfiguration,
  type MacosRelease,
} from "./macos-updates-api";
import { validPublicEdKey } from "./macos-upload";
import { MacosUploadPanel } from "./macos-upload-panel";

const explicitReads = {
  staleTime: Infinity,
  refetchOnMount: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

export function MacosUpdatesPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { can, session, reauthenticate } = useAdminSession();
  const [params, setParams] = useSearchParams();
  const cursor = params.get("cursor");
  const config = useQuery({
    queryKey: ["macos-update-config"],
    queryFn: () => getMacosConfiguration(client),
    ...explicitReads,
  });
  const releases = useQuery({
    queryKey: ["macos-updates", cursor],
    queryFn: () => listMacosReleases(client, cursor),
    ...explicitReads,
  });
  const [key, setKey] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [selected, setSelected] = useState<{
    release: MacosRelease;
    action: "publications" | "withdrawals";
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unknownOperationId, setUnknownOperationId] = useState<string | null>(
    null,
  );
  const [checking, setChecking] = useState(false);
  const [unknownVerification, setUnknownVerification] = useState<{
    releaseId: string;
    operationId: string;
    retryAllowed: boolean;
  } | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [resumeRelease, setResumeRelease] = useState<MacosRelease | null>(null);
  const [uploadUnresolved, setUploadUnresolved] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const manage =
    can("releases.manage") &&
    !unknownOperationId &&
    !unknownVerification &&
    !uploadUnresolved &&
    !uploadBusy;
  const changed = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["macos-update-config"] }),
      queryClient.invalidateQueries({ queryKey: ["macos-updates"] }),
    ]);
  };
  const fail = (caught: unknown) => {
    setError(
      caught instanceof Error ? caught.message : "The operation failed.",
    );
    if (caught instanceof OperationOutcomeUnknownError)
      setUnknownOperationId(caught.operationId);
    throw caught;
  };

  const runVerification = async (releaseId: string, operationId: string) => {
    setVerifying(releaseId);
    if (unknownVerification)
      setUnknownVerification({ releaseId, operationId, retryAllowed: false });
    try {
      await reauthenticate();
      await completeMacosUpload(client, releaseId, operationId);
      await changed();
      setUnknownVerification(null);
      setUnknownOperationId(null);
      setError(null);
    } catch (caught) {
      if (caught instanceof OperationOutcomeUnknownError)
        setUnknownVerification({ releaseId, operationId, retryAllowed: false });
      try {
        fail(caught);
      } catch {
        /* The visible error and receipt fence retain the outcome. */
      }
    } finally {
      setVerifying(null);
    }
  };

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setError(null);
    } catch {
      setError("Copy was unavailable. Select and copy the URL from its field.");
    }
  };
  const downloadConfig = () => {
    if (!config.data) return;
    try {
      const url = URL.createObjectURL(
        new Blob([publicMacosConfiguration(config.data)], {
          type: "application/json",
        }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "musicmute-macos-updates.json";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Configuration download failed.",
      );
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Mac updates"
        description="Configure Sparkle, upload signed MusicMute DMG releases, and publish updates from your dashboard."
      />
      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-destructive p-4 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}
      {unknownOperationId ? (
        <Button
          variant="outline"
          disabled={checking}
          onClick={() => {
            setChecking(true);
            void client
              .get<OperationReceipt>(
                `/admin/operations/${encodeURIComponent(unknownOperationId)}`,
              )
              .then(async (receipt) => {
                if (receipt.status === "pending") {
                  setError(
                    "The operation is still pending. Check its outcome again before continuing.",
                  );
                  return;
                }
                await changed();
                setUnknownOperationId(null);
                setUnknownVerification(null);
                setError(
                  receipt.status === "failed"
                    ? `The operation failed (${receipt.code ?? "OPERATION_FAILED"}).`
                    : null,
                );
              })
              .catch(async (caught: unknown) => {
                if (
                  caught instanceof ApiError &&
                  caught.status === 404 &&
                  unknownVerification
                ) {
                  try {
                    const release = await getMacosRelease(
                      client,
                      unknownVerification.releaseId,
                    );
                    await changed();
                    if (release.artifactState === "verified") {
                      setUnknownVerification(null);
                      setUnknownOperationId(null);
                      setError(null);
                    } else {
                      setUnknownVerification({
                        ...unknownVerification,
                        retryAllowed: true,
                      });
                      setError(
                        "The receipt is not available and the draft is awaiting verification. Check again after the server finishes, or explicitly retry verification with the same operation ID.",
                      );
                    }
                  } catch (readError) {
                    setError(
                      readError instanceof Error
                        ? readError.message
                        : "The draft could not be read.",
                    );
                  }
                  return;
                }
                setError(
                  caught instanceof Error
                    ? caught.message
                    : "The receipt could not be read.",
                );
              })
              .finally(() => setChecking(false));
          }}
        >
          Check operation outcome
        </Button>
      ) : null}
      {unknownVerification?.retryAllowed ? (
        <Button
          variant="outline"
          disabled={!!verifying}
          onClick={() =>
            void runVerification(
              unknownVerification.releaseId,
              unknownVerification.operationId,
            )
          }
        >
          Retry verification with same operation ID
        </Button>
      ) : null}
      {config.isLoading ? (
        <LoadingState rows={2} />
      ) : config.isError || !config.data ? (
        <ErrorState error={config.error} retry={() => void config.refetch()} />
      ) : (
        <>
          <section
            className="space-y-4 rounded-xl border bg-card p-5"
            aria-labelledby="macos-config-title"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 id="macos-config-title" className="font-semibold">
                  Sparkle configuration
                </h2>
                <p className="text-sm text-muted-foreground">
                  {config.data.configured
                    ? "Public key configured. The key is fixed once a release is created."
                    : "An owner must configure the Ed25519 public key before uploading an update."}
                </p>
              </div>
              <StatusBadge
                value={config.data.configured ? "configured" : "setup_required"}
              />
            </div>
            {[
              ["Sparkle feed URL", config.data.feedUrl],
              ["Download base URL", config.data.downloadBaseUrl],
            ].map(([label, value]) => (
              <div className="space-y-2" key={label}>
                <Label htmlFor={label.replaceAll(" ", "-")}>{label}</Label>
                <div className="flex gap-2">
                  <Input
                    id={label.replaceAll(" ", "-")}
                    readOnly
                    value={value}
                    className="font-mono text-xs"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label={`Copy ${label}`}
                    onClick={() => void copy(value)}
                  >
                    <Copy aria-hidden="true" />
                  </Button>
                </div>
              </div>
            ))}
            <div className="space-y-2">
              <Label htmlFor="macos-public-key">Ed25519 public key</Label>
              <Input
                id="macos-public-key"
                readOnly={session?.role !== "owner" || !manage}
                value={key ?? config.data.publicEdKey ?? ""}
                onChange={(event) => setKey(event.target.value)}
                placeholder="Base64 public key (32 bytes)"
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                Use the public key generated by Sparkle. Keep the private
                signing key in your local Keychain.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {session?.role === "owner" && manage ? (
                <Button
                  disabled={
                    !validPublicEdKey(key ?? "") ||
                    key === config.data.publicEdKey
                  }
                  onClick={() => setConfigOpen(true)}
                >
                  <ShieldCheck aria-hidden="true" />
                  Save public key
                </Button>
              ) : null}
              <Button
                variant="outline"
                disabled={!config.data.configured}
                onClick={downloadConfig}
              >
                <Download aria-hidden="true" />
                Download build configuration
              </Button>
            </div>
          </section>
          <section
            className="space-y-3 rounded-xl border bg-card p-5"
            aria-labelledby="macos-prepare-title"
          >
            <h2 id="macos-prepare-title" className="font-semibold">
              Prepare on your Mac
            </h2>
            <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
              <li>Download the public build configuration above.</li>
              <li>
                Build and notarize your release from the chrome-extension
                component with that configuration. Replace YOUR_NEW_VERSION with
                a newer marketing version and YOUR_NEW_BUILD with a higher
                integer build than previous releases.
              </li>
              <li>
                Prepare the DMG and signed appcast using your Sparkle Keychain
                account, then select both files below.
              </li>
            </ol>
            <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs">
              <code>{`MUSICMUTE_MAC_VERSION=YOUR_NEW_VERSION MUSICMUTE_MAC_BUILD=YOUR_NEW_BUILD MUSICMUTE_UPDATE_CONFIG_FILE=/path/musicmute-macos-updates.json npm run package:macos:release\nnpm run prepare:macos:update -- --release-result /path/release-result.json --dashboard-config /path/musicmute-macos-updates.json --keychain-account YOUR_SPARKLE_ACCOUNT`}</code>
            </pre>
          </section>
          {config.data.configured && !config.data.selectedReleaseId ? (
            <p className="text-sm text-muted-foreground">
              No update is currently published to the feed.
            </p>
          ) : null}
          {can("releases.manage") &&
          !unknownOperationId &&
          config.data.configured ? (
            <MacosUploadPanel
              key={resumeRelease?.id ?? "new"}
              existingRelease={resumeRelease ?? undefined}
              config={config.data}
              onChange={changed}
              onReset={() => setResumeRelease(null)}
              onUnresolved={setUploadUnresolved}
              onBusy={setUploadBusy}
            />
          ) : null}
        </>
      )}
      <section className="space-y-3" aria-labelledby="macos-releases-title">
        <h2 id="macos-releases-title" className="font-semibold">
          Mac releases
        </h2>
        {releases.isLoading ? (
          <LoadingState />
        ) : releases.isError ? (
          <ErrorState
            error={releases.error}
            retry={() => void releases.refetch()}
          />
        ) : releases.data?.items.length ? (
          <div className="overflow-x-auto rounded-xl border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Version / build</TableHead>
                  <TableHead>Artifact</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {releases.data.items.map((release) => (
                  <TableRow key={release.id}>
                    <TableCell className="whitespace-normal">
                      <p className="font-medium">
                        {release.versionName} ({release.buildNumber})
                      </p>
                      <p className="mt-1 max-w-80 break-all text-xs text-muted-foreground">
                        {release.archiveName}
                      </p>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <StatusBadge value={release.artifactState} />
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatBytes(release.bytes)}
                      </p>
                      <p
                        className="mt-1 max-w-48 break-all font-mono text-xs"
                        title={release.sha256Hex}
                      >
                        {release.sha256Hex}
                      </p>
                    </TableCell>
                    <TableCell>
                      <StatusBadge value={release.state} />
                      {config.data?.selectedReleaseId === release.id ? (
                        <p className="mt-1 text-xs font-medium text-primary">
                          In update feed
                        </p>
                      ) : null}
                      {release.publishedAt ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {formatDateTime(release.publishedAt)}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell>{formatDateTime(release.createdAt)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        {manage &&
                        release.state === "draft" &&
                        release.artifactState === "awaiting_upload" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!!verifying}
                            onClick={() =>
                              void runVerification(
                                release.id,
                                createOperationId(),
                              )
                            }
                          >
                            {verifying === release.id
                              ? "Verifying…"
                              : "Verify upload"}
                          </Button>
                        ) : null}
                        {manage &&
                        release.state === "draft" &&
                        release.artifactState === "awaiting_upload" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!!verifying}
                            onClick={() => setResumeRelease(release)}
                          >
                            Resume upload
                          </Button>
                        ) : null}
                        {manage &&
                        ["draft", "withdrawn"].includes(release.state) ? (
                          <Button
                            size="sm"
                            disabled={
                              release.artifactState !== "verified" ||
                              !config.data?.configured ||
                              !!verifying
                            }
                            onClick={() =>
                              setSelected({ release, action: "publications" })
                            }
                          >
                            {release.state === "withdrawn"
                              ? "Republish"
                              : "Publish"}
                          </Button>
                        ) : null}
                        {manage && release.state === "published" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setSelected({ release, action: "withdrawals" })
                            }
                          >
                            Withdraw
                          </Button>
                        ) : null}
                        {release.state === "published" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void copy(release.downloadUrl)}
                          >
                            Copy download URL
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState
            title="No Mac releases"
            description="Configure the public key and upload your first signed update."
          />
        )}
        <CursorPagination
          cursor={cursor}
          nextCursor={releases.data?.nextCursor ?? null}
          pending={releases.isFetching}
          onCursorChange={(value) => {
            const next = new URLSearchParams(params);
            if (value) next.set("cursor", value);
            else next.delete("cursor");
            setParams(next);
          }}
        />
      </section>
      <ReasonDialog
        open={configOpen}
        onOpenChange={setConfigOpen}
        title="Configure Sparkle public key"
        description="This public key must match the key embedded in MusicMute and used to sign updates. It cannot be changed after a release is created."
        confirmLabel="Save public key"
        freshAuth
        onReauthenticate={reauthenticate}
        summary={<p className="break-all font-mono text-xs">{key}</p>}
        onConfirm={async (reason) => {
          if (
            !config.data ||
            !manage ||
            session?.role !== "owner" ||
            !validPublicEdKey(key ?? "")
          )
            throw new Error("Public key configuration is unavailable.");
          try {
            await configureMacosUpdates(client, {
              publicEdKey: key!,
              expectedRevision: config.data.revision,
              operationId: createOperationId(),
              reason,
            });
            setKey(null);
            await changed();
          } catch (caught) {
            fail(caught);
          }
        }}
      />
      <ReasonDialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title={
          selected?.action === "withdrawals"
            ? "Withdraw Mac update"
            : "Publish Mac update"
        }
        description={
          selected?.action === "withdrawals"
            ? "Stop advertising this release in the Sparkle feed. Existing immutable archive downloads remain available."
            : "Make this verified release available through the public Sparkle feed and download route."
        }
        confirmLabel={
          selected?.action === "withdrawals"
            ? "Withdraw update"
            : "Publish update"
        }
        destructive={selected?.action === "withdrawals"}
        freshAuth
        onReauthenticate={reauthenticate}
        summary={
          selected ? (
            <p>
              MusicMute {selected.release.versionName} (
              {selected.release.buildNumber}) ·{" "}
              {formatBytes(selected.release.bytes)}
            </p>
          ) : null
        }
        onConfirm={async (reason) => {
          if (
            !selected ||
            !config.data ||
            !manage ||
            (selected.action === "publications" &&
              selected.release.artifactState !== "verified")
          )
            throw new Error("This release is unavailable for publication.");
          try {
            await changeMacosPublication(
              client,
              selected.release.id,
              selected.action,
              {
                expectedRevision: selected.release.revision,
                expectedConfigurationRevision: config.data.revision,
                operationId: createOperationId(),
                reason,
              },
            );
            await changed();
          } catch (caught) {
            fail(caught);
          }
        }}
      />
    </div>
  );
}
