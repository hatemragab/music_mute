import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Link, useSearchParams } from "react-router";

import { createOperationId } from "@/api/api-client";
import { useAdminSession, useApiClient } from "@/auth/admin-session";
import { CursorPagination } from "@/components/cursor-pagination";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from "@/components/page";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime, titleCase } from "@/lib/format";
import { ReleaseDraftForm } from "./release-draft-form";
import {
  createRelease,
  getReleaseProposal,
  listReleases,
  type ReleaseDraftInput,
} from "./releases-api";

export function ReleasesPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { can } = useAdminSession();
  const [params, setParams] = useSearchParams();
  const platform = params.get("platform") ?? "all";
  const source = params.get("source") ?? "all";
  const state = params.get("state") ?? "all";
  const cursor = params.get("cursor");
  const [createOpen, setCreateOpen] = useState(false);
  const loadProposal = useCallback(
    (
      nextPlatform: ReleaseDraftInput["platform"],
      nextSource: ReleaseDraftInput["source"],
    ) => getReleaseProposal(client, nextPlatform, nextSource),
    [client],
  );
  const releases = useQuery({
    queryKey: ["releases", platform, source, state, cursor],
    queryFn: () =>
      listReleases(client, {
        platform: platform === "all" ? undefined : platform,
        source: source === "all" ? undefined : source,
        state: state === "all" ? undefined : state,
        cursor,
      }),
  });
  const change = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== "all") next.set(name, value);
    else next.delete(name);
    if (name !== "cursor") next.delete("cursor");
    setParams(next);
  };
  const create = useMutation({
    mutationFn: (input: ReleaseDraftInput & { reason: string }) =>
      createRelease(client, { ...input, operationId: createOperationId() }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["releases"] }),
  });
  return (
    <div className="space-y-6">
      <PageHeader
        title="Releases"
        description="Draft, artifact verification and publication are separate lifecycle states."
        actions={
          can("releases.manage") ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus aria-hidden="true" /> Create draft
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-wrap gap-2">
        <Select
          value={platform}
          onValueChange={(value) => change("platform", value)}
        >
          <SelectTrigger className="w-40" aria-label="Filter platform">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All platforms</SelectItem>
            <SelectItem value="android">Android</SelectItem>
            <SelectItem value="ios">iOS</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={source}
          onValueChange={(value) => change("source", value)}
        >
          <SelectTrigger className="w-44" aria-label="Filter distribution">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All distributions</SelectItem>
            <SelectItem value="direct_apk">Direct APK</SelectItem>
            <SelectItem value="google_play">Google Play</SelectItem>
            <SelectItem value="app_store">App Store</SelectItem>
          </SelectContent>
        </Select>
        <Select value={state} onValueChange={(value) => change("state", value)}>
          <SelectTrigger className="w-40" aria-label="Filter release state">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All states</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="published">Published</SelectItem>
            <SelectItem value="withdrawn">Withdrawn</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {releases.isLoading ? (
        <LoadingState />
      ) : releases.isError ? (
        <ErrorState
          error={releases.error}
          retry={() => void releases.refetch()}
        />
      ) : releases.data?.items.length ? (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Release</TableHead>
                  <TableHead>Platform</TableHead>
                  <TableHead>Distribution</TableHead>
                  <TableHead>Release state</TableHead>
                  <TableHead>Artifact</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {releases.data.items.map((release) => (
                  <TableRow key={release.id}>
                    <TableCell>
                      <Link
                        to={`/releases/${release.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {release.versionName}{" "}
                        <span className="font-mono text-xs">
                          ({release.buildNumber})
                        </span>
                      </Link>
                    </TableCell>
                    <TableCell className="capitalize">
                      {release.platform}
                    </TableCell>
                    <TableCell>{titleCase(release.source)}</TableCell>
                    <TableCell>
                      <StatusBadge value={release.state} />
                    </TableCell>
                    <TableCell>
                      {release.artifactState ? (
                        <StatusBadge value={release.artifactState} />
                      ) : (
                        "Not required"
                      )}
                    </TableCell>
                    <TableCell>{formatDateTime(release.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          title="No releases"
          description="No releases match the selected filters."
        />
      )}
      <CursorPagination
        cursor={cursor}
        nextCursor={releases.data?.nextCursor ?? null}
        pending={releases.isFetching}
        onCursorChange={(value) => change("cursor", value ?? "")}
      />
      <ReleaseDraftForm
        open={createOpen}
        onOpenChange={setCreateOpen}
        getProposal={loadProposal}
        onSubmit={(input) => create.mutateAsync(input).then(() => undefined)}
      />
    </div>
  );
}
