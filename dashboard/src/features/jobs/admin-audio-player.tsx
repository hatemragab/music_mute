import { useEffect, useRef, useState } from "react";

import type { MediaGrant } from "@/api/contracts";
import { Button } from "@/components/ui/button";

export function AdminAudioPlayer({
  grant,
  label,
  onExpired,
  onDownloadFallback,
}: {
  grant: MediaGrant;
  label: string;
  onExpired(): void;
  onDownloadFallback(): void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = failedUrl === grant.url;
  useEffect(() => {
    const audio = audioRef.current;
    const remaining = Date.parse(grant.expiresAt) - Date.now();
    const timer = window.setTimeout(
      onExpired,
      Math.min(2_147_483_647, Math.max(0, remaining)),
    );
    return () => {
      window.clearTimeout(timer);
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
    };
  }, [grant.expiresAt, onExpired]);
  return (
    <div className="space-y-2">
      <audio
        ref={audioRef}
        className="w-full"
        controls
        preload="none"
        src={grant.url}
        aria-label={label}
        onError={() => setFailedUrl(grant.url)}
      >
        Your browser cannot play this audio. Use the download action instead.
      </audio>
      {failed ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 text-sm text-destructive"
        >
          <span>Your browser could not play this audio format.</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onDownloadFallback}
          >
            Request download access
          </Button>
        </div>
      ) : null}
    </div>
  );
}
