import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";

import { useApiClient } from "@/auth/admin-session";
import { CursorPagination } from "@/components/cursor-pagination";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from "@/components/page";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
import { formatDateTime } from "@/lib/format";
import { listUsers } from "./users-api";

export function UsersPage() {
  const client = useApiClient();
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useState(params.get("query") ?? "");
  const query = params.get("query") ?? "";
  const status = params.get("status") ?? "all";
  const cursor = params.get("cursor");
  useEffect(() => {
    if (draft.trim() === query) return;
    const timer = window.setTimeout(() => {
      const next = new URLSearchParams(params);
      if (draft.trim()) next.set("query", draft.trim());
      else next.delete("query");
      next.delete("cursor");
      setParams(next, { replace: true });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [draft, params, query, setParams]);
  const validQuery =
    !query ||
    query.includes("@") ||
    /^[a-f\d]{24}$/i.test(query) ||
    query.length >= 2;
  const filters = {
    query: query || undefined,
    status: status === "all" ? undefined : status,
    cursor,
  };
  const users = useQuery({
    queryKey: ["users", filters],
    queryFn: () => listUsers(client, filters),
    enabled: validQuery,
  });
  const change = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== "all") next.set(name, value);
    else next.delete(name);
    if (name !== "cursor") next.delete("cursor");
    setParams(next);
  };
  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        description="Support directory for account state. Open an account to review quotas and manual abuse restrictions."
      />
      <div className="grid gap-2 rounded-xl border bg-card p-3 md:grid-cols-2">
        <div>
          <Input
            aria-label="Search users"
            placeholder="Email, exact ID, or supported prefix"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          {!validQuery ? (
            <p className="mt-1 text-xs text-destructive">
              Enter at least two characters, an email, or an exact ID.
            </p>
          ) : null}
        </div>
        <Select
          value={status}
          onValueChange={(value) => change("status", value)}
        >
          <SelectTrigger aria-label="Filter account status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All account states</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="disabled">Disabled</SelectItem>
            <SelectItem value="deleting">Deleting</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {!validQuery ? null : users.isLoading ? (
        <LoadingState />
      ) : users.isError ? (
        <ErrorState error={users.error} retry={() => void users.refetch()} />
      ) : users.data?.items.length ? (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Revision</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.data.items.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell>
                      <Link
                        to={`/users/${user.id}`}
                        className="font-medium text-primary hover:underline"
                      >
                        {user.displayName || user.email || "Unnamed user"}
                      </Link>
                      <div className="font-mono text-xs text-muted-foreground">
                        {user.id}
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge value={user.status} />
                    </TableCell>
                    <TableCell>{formatDateTime(user.createdAt)}</TableCell>
                    <TableCell className="font-mono">{user.revision}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          title="No users"
          description="No users match the supported search and filters."
        />
      )}
      <CursorPagination
        cursor={cursor}
        nextCursor={users.data?.nextCursor ?? null}
        pending={users.isFetching}
        onCursorChange={(value) => change("cursor", value ?? "")}
      />
    </div>
  );
}
