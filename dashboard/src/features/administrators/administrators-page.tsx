import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, ShieldCheck } from "lucide-react";
import { useSearchParams } from "react-router";

import { createOperationId } from "@/api/api-client";
import type { AdminAccess, AdminRole } from "@/api/contracts";
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
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AdminAccessForm } from "./admin-access-form";
import {
  addAdministrator,
  listAdministrators,
  updateAdministrator,
} from "./administrators-api";
import { ROLE_DETAILS } from "./role-permissions";

export function AdministratorsPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { session, reauthenticate, refresh } = useAdminSession();
  const [params, setParams] = useSearchParams();
  const activeFilter = params.get("active") ?? "all";
  const cursor = params.get("cursor");
  const [addOpen, setAddOpen] = useState(false);
  const [pending, setPending] = useState<{
    admin: AdminAccess;
    role?: AdminRole;
    active?: boolean;
  } | null>(null);
  const administrators = useQuery({
    queryKey: ["administrators", activeFilter, cursor],
    queryFn: () =>
      listAdministrators(client, {
        active: activeFilter === "all" ? undefined : activeFilter === "true",
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
  const add = useMutation({
    mutationFn: (input: {
      verifiedEmail: string;
      role: AdminRole;
      reason: string;
    }) =>
      addAdministrator(client, { ...input, operationId: createOperationId() }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["administrators"] }),
  });
  const update = useMutation({
    mutationFn: ({
      target,
      reason,
    }: {
      target: NonNullable<typeof pending>;
      reason: string;
    }) =>
      updateAdministrator(client, target.admin.uid, {
        expectedRevision: target.admin.revision,
        operationId: createOperationId(),
        reason,
        role: target.role,
        active: target.active,
      }),
    onSuccess: async (_, variables) => {
      await queryClient.invalidateQueries({ queryKey: ["administrators"] });
      if (variables.target.admin.uid === session?.uid) await refresh();
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Administrators"
        description="Manage verified administrator identities and their fixed operational roles. At least one active owner is always required."
        actions={
          <Button onClick={() => setAddOpen(true)}>
            <Plus aria-hidden="true" /> Add administrator
          </Button>
        }
      />
      <div className="flex items-center gap-3">
        <Select
          value={activeFilter}
          onValueChange={(value) => change("active", value)}
        >
          <SelectTrigger
            className="w-48"
            aria-label="Filter administrator state"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All administrators</SelectItem>
            <SelectItem value="true">Active</SelectItem>
            <SelectItem value="false">Inactive</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {administrators.isLoading ? (
        <LoadingState />
      ) : administrators.isError ? (
        <ErrorState
          error={administrators.error}
          retry={() => void administrators.refetch()}
        />
      ) : administrators.data?.items.length ? (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Administrator</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Revision</TableHead>
                  <TableHead className="text-right">Manage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {administrators.data.items.map((admin) => (
                  <TableRow key={admin.uid}>
                    <TableCell>
                      <div className="font-medium text-foreground">
                        {admin.verifiedEmail}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {admin.uid}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div>{ROLE_DETAILS[admin.role].label}</div>
                      <div className="max-w-xs text-xs text-muted-foreground">
                        {ROLE_DETAILS[admin.role].description}
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        value={admin.active ? "active" : "disabled"}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {admin.revision}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex items-center gap-2">
                        <Select
                          value={admin.role}
                          onValueChange={(role) =>
                            setPending({ admin, role: role as AdminRole })
                          }
                        >
                          <SelectTrigger
                            className="w-40"
                            aria-label={`Change role for ${admin.verifiedEmail}`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {Object.entries(ROLE_DETAILS).map(
                              ([role, detail]) => (
                                <SelectItem key={role} value={role}>
                                  {detail.label}
                                </SelectItem>
                              ),
                            )}
                          </SelectContent>
                        </Select>
                        <Switch
                          checked={admin.active}
                          aria-label={`${admin.active ? "Deactivate" : "Reactivate"} ${admin.verifiedEmail}`}
                          onCheckedChange={(active) =>
                            setPending({ admin, active })
                          }
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          title="No administrators"
          description="No records match the selected state."
        />
      )}
      <CursorPagination
        cursor={cursor}
        nextCursor={administrators.data?.nextCursor ?? null}
        pending={administrators.isFetching}
        onCursorChange={(value) => change("cursor", value ?? "")}
      />
      <div className="rounded-xl border bg-muted/20 p-4 text-sm text-muted-foreground">
        <ShieldCheck
          aria-hidden="true"
          className="mr-2 inline size-4 text-primary"
        />
        Role changes use the backend revision and require a fresh Google
        authentication. Concurrent changes are never overwritten automatically.
      </div>
      <AdminAccessForm
        open={addOpen}
        onOpenChange={setAddOpen}
        reauthenticate={reauthenticate}
        onSubmit={(input) => add.mutateAsync(input).then(() => undefined)}
      />
      <ReasonDialog
        open={Boolean(pending)}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={
          pending?.role
            ? "Change administrator role"
            : pending?.active
              ? "Reactivate administrator"
              : "Deactivate administrator"
        }
        description="Review the target and impact after fresh authentication. The server protects the last active owner."
        confirmLabel="Confirm change"
        destructive={pending?.active === false}
        freshAuth
        onReauthenticate={reauthenticate}
        summary={
          pending ? (
            <>
              <p className="font-medium">{pending.admin.verifiedEmail}</p>
              <p className="text-muted-foreground">
                {pending.role
                  ? `${ROLE_DETAILS[pending.admin.role].label} → ${ROLE_DETAILS[pending.role].label}`
                  : `${pending.admin.active ? "Active" : "Inactive"} → ${pending.active ? "Active" : "Inactive"}`}
              </p>
            </>
          ) : null
        }
        onConfirm={(reason) =>
          pending
            ? update
                .mutateAsync({ target: pending, reason })
                .then(() => undefined)
            : Promise.resolve()
        }
      />
    </div>
  );
}
