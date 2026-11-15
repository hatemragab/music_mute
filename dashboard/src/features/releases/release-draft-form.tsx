import { useEffect, useState } from "react";

import type {
  ReleasePlatform,
  ReleaseProposal,
  ReleaseWriteSource,
} from "@/api/contracts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  GOOGLE_PLAY_LISTING_URL,
  type ReleaseDraftInput,
} from "./releases-api";

interface ReleaseDraftFormProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  onSubmit(input: ReleaseDraftInput & { reason: string }): Promise<void>;
  getProposal?(
    platform: ReleasePlatform,
    source: ReleaseWriteSource,
  ): Promise<ReleaseProposal>;
  initial?: ReleaseDraftInput;
}

const releaseVersionParts = (versionName: string) => {
  if (!/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2}$/.test(versionName))
    return null;
  const parts = versionName.split(".").map((part) => BigInt(part));
  return [parts[0] ?? 0n, parts[1] ?? 0n, parts[2] ?? 0n] as const;
};

const isVersionNewer = (candidate: string, current: string) => {
  const candidateParts = releaseVersionParts(candidate);
  const currentParts = releaseVersionParts(current);
  if (!candidateParts || !currentParts) return false;
  for (let index = 0; index < candidateParts.length; index++) {
    if (candidateParts[index] > currentParts[index]) return true;
    if (candidateParts[index] < currentParts[index]) return false;
  }
  return false;
};

export function ReleaseDraftForm(props: ReleaseDraftFormProps) {
  return props.open ? <OpenReleaseDraftForm {...props} /> : null;
}

function OpenReleaseDraftForm({
  open,
  onOpenChange,
  onSubmit,
  getProposal,
  initial,
}: ReleaseDraftFormProps) {
  const [platform, setPlatform] = useState<ReleasePlatform>(
    initial?.platform ?? "android",
  );
  const source: ReleaseWriteSource =
    platform === "ios" ? "app_store" : "google_play";
  const [versionName, setVersionName] = useState(initial?.versionName ?? "");
  const [buildNumber, setBuildNumber] = useState(
    initial ? String(initial.buildNumber) : "",
  );
  const [changelogEn, setChangelogEn] = useState(initial?.changelogEn ?? "");
  const [storeUrl, setStoreUrl] = useState(initial?.storeUrl ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<ReleaseProposal | null>(null);
  const [proposalRequestError, setProposalRequestError] = useState<
    string | null
  >(null);

  useEffect(() => {
    if (initial || !getProposal) return;
    let cancelled = false;
    void getProposal(platform, source)
      .then((result) => {
        if (cancelled) return;
        if (result.platform !== platform || result.source !== source)
          throw new Error(
            "The release proposal did not match the selected channel.",
          );
        setProposal(result);
        setVersionName(result.suggested.versionName);
        setBuildNumber(String(result.suggested.buildNumber));
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setProposalRequestError(
          caught instanceof Error
            ? caught.message
            : "The current release could not be loaded.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [getProposal, initial, platform, source]);

  const selectChannel = (nextPlatform: ReleasePlatform) => {
    setPlatform(nextPlatform);
    if (!initial) {
      setProposal(null);
      setProposalRequestError(null);
      setVersionName("");
      setBuildNumber("");
    }
  };

  const proposalError =
    proposalRequestError ??
    (!initial && !getProposal
      ? "The current release could not be loaded."
      : null);
  const proposalLoading =
    !initial && !!getProposal && !proposal && !proposalRequestError;

  const build = Number(buildNumber);
  const needsStoreUrl = platform === "ios";
  const versionIsNewer =
    !!initial ||
    (!!proposal &&
      isVersionNewer(versionName.trim(), proposal.current.versionName));
  const buildIsNewer =
    !!initial || (!!proposal && build > proposal.current.buildNumber);
  const valid =
    (!!initial || !!proposal) &&
    versionName.trim() &&
    versionIsNewer &&
    Number.isInteger(build) &&
    build > 0 &&
    buildIsNewer &&
    changelogEn.trim() &&
    reason.trim() &&
    (!needsStoreUrl || /^https:\/\//.test(storeUrl));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        platform,
        source,
        versionName: versionName.trim(),
        buildNumber: build,
        changelogEn: changelogEn.trim(),
        storeUrl: needsStoreUrl ? storeUrl.trim() : GOOGLE_PLAY_LISTING_URL,
        reason: reason.trim(),
      });
      onOpenChange(false);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The draft could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {initial ? "Edit release draft" : "Create release draft"}
          </DialogTitle>
          <DialogDescription>
            Drafts record the version served by the store. Publication is a
            separate reviewed step.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="release-platform">Platform</Label>
            <Select
              value={platform}
              onValueChange={(value) => {
                selectChannel(value as ReleasePlatform);
              }}
            >
              <SelectTrigger id="release-platform" aria-label="Platform">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="android">Android</SelectItem>
                <SelectItem value="ios">iOS</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="release-distribution">Distribution</Label>
            <Select value={source} disabled>
              <SelectTrigger
                id="release-distribution"
                aria-label="Distribution"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {platform === "android" ? (
                  <SelectItem value="google_play">Google Play</SelectItem>
                ) : (
                  <SelectItem value="app_store">App Store</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>
          {!initial ? (
            <div className="rounded-lg border bg-muted/40 px-3 py-2 sm:col-span-2">
              <p className="text-sm font-medium" aria-live="polite">
                {proposalLoading
                  ? "Loading current release…"
                  : proposal
                    ? `Current release: ${proposal.current.versionName} (${proposal.current.buildNumber})`
                    : "Current release unavailable"}
              </p>
              {proposal ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  The proposed values are editable, but both must remain newer.
                </p>
              ) : null}
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="release-version">Version name</Label>
            <Input
              id="release-version"
              value={versionName}
              onChange={(event) => setVersionName(event.target.value)}
              placeholder="1.2.0"
              disabled={!initial && !proposal}
              aria-invalid={!versionIsNewer}
              aria-describedby="release-version-help"
            />
            {!initial && proposal && !versionIsNewer ? (
              <p id="release-version-help" className="text-xs text-destructive">
                Version must be newer than {proposal.current.versionName}.
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="release-build">Build number</Label>
            <Input
              id="release-build"
              type="number"
              min="1"
              step="1"
              value={buildNumber}
              onChange={(event) => setBuildNumber(event.target.value)}
              disabled={!initial && !proposal}
              aria-invalid={!buildIsNewer}
              aria-describedby="release-build-help"
            />
            {!initial && proposal && !buildIsNewer ? (
              <p id="release-build-help" className="text-xs text-destructive">
                Build number must be greater than {proposal.current.buildNumber}
                .
              </p>
            ) : null}
          </div>
          {platform === "android" ? (
            <p className="text-sm text-muted-foreground sm:col-span-2">
              Upload the Android App Bundle in Play Console. This form records
              the version name and build number Play is serving. MusicMute does
              not receive the file.
            </p>
          ) : null}
          {needsStoreUrl ? (
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="store-url">Store URL</Label>
              <Input
                id="store-url"
                type="url"
                value={storeUrl}
                onChange={(event) => setStoreUrl(event.target.value)}
                placeholder="https://…"
              />
            </div>
          ) : null}
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="release-changelog">English changelog</Label>
            <Textarea
              id="release-changelog"
              value={changelogEn}
              onChange={(event) => setChangelogEn(event.target.value)}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="release-reason">Reason</Label>
            <Textarea
              id="release-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {proposalError ? (
          <p role="alert" className="text-sm text-destructive">
            {proposalError}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!valid || busy} onClick={() => void submit()}>
            {initial ? "Save draft" : "Create draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
