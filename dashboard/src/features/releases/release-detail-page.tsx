import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Pencil, ShieldCheck } from "lucide-react";
import { Link, useParams } from "react-router";

import { createOperationId } from "@/api/api-client";
import { useAdminSession, useApiClient } from "@/auth/admin-session";
import {
  ErrorState,
  LoadingState,
  PageHeader,
  PageSection,
} from "@/components/page";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatBytes, formatDateTime, titleCase } from "@/lib/format";
import { ApkUploadPanel } from "./apk-upload-panel";
import { ReleaseDraftForm } from "./release-draft-form";
import {
  getRelease,
  updateRelease,
  type ReleaseDraftInput,
} from "./releases-api";

export function ReleaseDetailPage() {
  const { id = "" } = useParams();
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { can } = useAdminSession();
  const [editing, setEditing] = useState(false);
  const release = useQuery({
    queryKey: ["release", id],
    queryFn: () => getRelease(client, id),
    enabled: Boolean(id),
  });
  const update = useMutation({
    mutationFn: (input: ReleaseDraftInput & { reason: string }) => {
      if (!release.data) throw new Error("Release is unavailable.");
      return updateRelease(client, release.data.id, {
        ...input,
        expectedRevision: release.data.revision,
        operationId: createOperationId(),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["release", id] });
      await queryClient.invalidateQueries({ queryKey: ["releases"] });
    },
  });
  if (release.isLoading) return <LoadingState />;
  if (release.isError || !release.data)
    return (
      <ErrorState error={release.error} retry={() => void release.refetch()} />
    );
  const data = release.data;
  const editable = can("releases.manage") && data.state === "draft";
  return (
    <div className="space-y-6">
      <Link
        to="/releases"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-4" /> Releases
      </Link>
      <PageHeader
        title={`${data.versionName} (${data.buildNumber})`}
        description={`${titleCase(data.source)} · ${data.id}`}
        actions={
          <div className="flex gap-2">
            {editable ? (
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil aria-hidden="true" /> Edit draft
              </Button>
            ) : null}
            {can("releases.read") ? (
              <Button asChild>
                <Link to={`/update-policy?releaseId=${data.id}`}>
                  <ShieldCheck aria-hidden="true" /> Review policy
                </Link>
              </Button>
            ) : null}
          </div>
        }
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="p-5">
            <PageSection title="Release">
              <dl className="grid gap-4 text-sm">
                <div>
                  <dt className="text-muted-foreground">State</dt>
                  <dd>
                    <StatusBadge value={data.state} />
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">
                    Platform / distribution
                  </dt>
                  <dd className="capitalize">
                    {data.platform} · {titleCase(data.source)}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Created</dt>
                  <dd>{formatDateTime(data.createdAt)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Published</dt>
                  <dd>{formatDateTime(data.publishedAt)}</dd>
                </div>
                {data.storeUrl ? (
                  <div>
                    <dt className="text-muted-foreground">Store</dt>
                    <dd>
                      <a
                        className="text-primary hover:underline"
                        href={data.storeUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open store listing
                      </a>
                    </dd>
                  </div>
                ) : null}
              </dl>
            </PageSection>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <PageSection title="Artifact">
              <dl className="grid gap-4 text-sm">
                <div>
                  <dt className="text-muted-foreground">Verification</dt>
                  <dd>
                    {data.artifactState ? (
                      <StatusBadge value={data.artifactState} />
                    ) : (
                      "Not required for this distribution"
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Size</dt>
                  <dd>{formatBytes(data.bytes)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">SHA-256</dt>
                  <dd className="font-mono text-xs break-all">
                    {data.sha256Hex ?? "Not available"}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Signer SHA-256</dt>
                  <dd className="font-mono text-xs break-all">
                    {data.signerSha256Hex ?? "Not available"}
                  </dd>
                </div>
                {data.rejectionCode ? (
                  <div>
                    <dt className="text-muted-foreground">Rejection code</dt>
                    <dd className="text-destructive">{data.rejectionCode}</dd>
                  </div>
                ) : null}
              </dl>
            </PageSection>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardContent className="p-5">
          <PageSection title="English changelog">
            <p className="whitespace-pre-wrap text-sm leading-relaxed">
              {data.changelogEn}
            </p>
          </PageSection>
        </CardContent>
      </Card>
      {editable ? (
        <ApkUploadPanel
          release={data}
          onComplete={() => void release.refetch()}
        />
      ) : null}
      <ReleaseDraftForm
        open={editing}
        onOpenChange={setEditing}
        initial={{
          platform: data.platform,
          source: data.source,
          versionName: data.versionName,
          buildNumber: data.buildNumber,
          changelogEn: data.changelogEn,
          storeUrl: data.storeUrl,
        }}
        onSubmit={(input) => update.mutateAsync(input).then(() => undefined)}
      />
    </div>
  );
}
