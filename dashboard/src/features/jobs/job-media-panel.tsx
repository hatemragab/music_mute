import { useCallback, useEffect, useState } from "react";
import { Download, Play, RefreshCw } from "lucide-react";

import { createOperationId } from "@/api/api-client";
import type { JobDetail, MediaGrant } from "@/api/contracts";
import { useAdminSession, useApiClient } from "@/auth/admin-session";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatBytes, formatDateTime } from "@/lib/format";
import { AdminAudioPlayer } from "./admin-audio-player";
import { requestMediaGrant } from "./jobs-api";
import { MediaAccessDialog } from "./media-access-dialog";

type Pending = { asset: "input" | "result"; action: "play" | "download" };

export function JobMediaPanel({ job }: { job: JobDetail }) {
  const client = useApiClient();
  const { can, reauthenticate } = useAdminSession();
  const [pending, setPending] = useState<Pending | null>(null);
  const [playback, setPlayback] = useState<{
    asset: "input" | "result";
    grant: MediaGrant;
  } | null>(null);
  const [expired, setExpired] = useState<Pending | null>(null);
  const clearPlayback = useCallback(() => setPlayback(null), []);
  useEffect(() => () => clearPlayback(), [clearPlayback, job.id]);
  if (!can("media.read")) return null;
  const available = {
    input: job.media.inputAvailable,
    result: job.media.resultAvailable,
  };
  const request = (reason: string) => {
    if (!pending) throw new Error("No media action is pending.");
    return requestMediaGrant(client, job.id, {
      asset: pending.asset,
      purpose: pending.action,
      reason,
      operationId: createOperationId(),
    });
  };
  const granted = (grant: MediaGrant) => {
    if (!pending) return;
    if (pending.action === "play") {
      setPlayback({ asset: pending.asset, grant });
      setExpired(null);
    } else {
      const anchor = document.createElement("a");
      anchor.href = grant.url;
      anchor.download = grant.filename;
      anchor.rel = "noopener noreferrer";
      anchor.click();
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Private media</CardTitle>
        <CardDescription>
          Grants are requested only when you choose an action and expire after
          five minutes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {(["input", "result"] as const).map((asset) => (
            <div key={asset} className="flex gap-2">
              <Button
                variant="outline"
                disabled={!available[asset]}
                onClick={() => setPending({ asset, action: "play" })}
              >
                <Play aria-hidden="true" /> Play{" "}
                {asset === "input" ? "input" : "vocals"}
              </Button>
              <Button
                variant="outline"
                disabled={!available[asset]}
                onClick={() => setPending({ asset, action: "download" })}
              >
                <Download aria-hidden="true" /> Download{" "}
                {asset === "input" ? "input" : "vocals"}
              </Button>
            </div>
          ))}
        </div>
        {playback ? (
          <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="font-medium capitalize">
                {playback.asset} audio
              </span>
              <span className="text-xs text-muted-foreground">
                {formatBytes(playback.grant.bytes)} · expires{" "}
                {formatDateTime(playback.grant.expiresAt)}
              </span>
            </div>
            <AdminAudioPlayer
              grant={playback.grant}
              label={`${playback.asset} audio for job ${job.id}`}
              onExpired={() => {
                setExpired({ asset: playback.asset, action: "play" });
                clearPlayback();
              }}
              onDownloadFallback={() =>
                setPending({ asset: playback.asset, action: "download" })
              }
            />
          </div>
        ) : null}
        {expired ? (
          <div className="flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
            <span>Media access expired.</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setPending(expired)}
            >
              <RefreshCw aria-hidden="true" /> Renew access
            </Button>
          </div>
        ) : null}
        <MediaAccessDialog
          open={Boolean(pending)}
          onOpenChange={(open) => {
            if (!open) setPending(null);
          }}
          asset={pending?.asset ?? "input"}
          action={pending?.action ?? "play"}
          reauthenticate={reauthenticate}
          requestGrant={request}
          onGranted={granted}
        />
      </CardContent>
    </Card>
  );
}
