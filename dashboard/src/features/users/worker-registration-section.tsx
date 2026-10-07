import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router";

import {
  ApiError,
  createOperationId,
  OperationOutcomeUnknownError,
} from "@/api/api-client";
import type { OperationReceipt, UserDetail } from "@/api/contracts";
import { useAdminSession, useApiClient } from "@/auth/admin-session";
import { PageSection } from "@/components/page";
import { ReasonDialog } from "@/components/reason-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { getUser, setWorkerRegistration } from "./users-api";

interface RegistrationChange {
  workerRegistrationAllowed: boolean;
  expectedRevision: number;
  operationId: string;
}

export function WorkerRegistrationSection({
  data,
  onUpdated,
}: {
  data: UserDetail;
  onUpdated(data: UserDetail): Promise<void>;
}) {
  const client = useApiClient();
  const { can, reauthenticate } = useAdminSession();
  const [change, setChange] = useState<RegistrationChange | null>(null);
  const [unknownOperationId, setUnknownOperationId] = useState<string | null>(
    null,
  );
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const canManage = can("users.worker-registration.manage");
  const active = data.status === "active";
  const update = useMutation({
    mutationFn: async (reason: string) => {
      if (!change || !canManage || !active || unknownOperationId)
        throw new Error("Worker registration cannot be changed right now.");
      return setWorkerRegistration(client, data.id, { ...change, reason });
    },
    onError: async (error) => {
      if (error instanceof OperationOutcomeUnknownError) {
        setUnknownOperationId(error.operationId);
        setChange(null);
        setNotice(
          "The change outcome is unresolved. Check the operation outcome before making another change.",
        );
      } else if (error instanceof ApiError && error.status === 409) {
        setChange(null);
        setNotice("The account changed. Review its saved value and try again.");
        await getUser(client, data.id)
          .then(onUpdated)
          .catch(() => undefined);
      }
    },
    onSuccess: async (saved) => {
      await onUpdated(saved);
      setChange(null);
      setNotice(
        saved.workerRegistrationAllowed
          ? "Worker registration is allowed. Registered machines keep their own controls."
          : "New worker registrations are blocked. Existing machines keep running under their own controls.",
      );
    },
  });

  const checkOutcome = async () => {
    if (!unknownOperationId) return;
    setChecking(true);
    try {
      const receipt = await client.get<OperationReceipt>(
        `/admin/operations/${encodeURIComponent(unknownOperationId)}`,
      );
      if (receipt.status === "pending") {
        setNotice("The operation is still pending. Check its outcome again.");
        return;
      }
      await onUpdated(await getUser(client, data.id));
      setUnknownOperationId(null);
      setNotice(
        receipt.status === "succeeded"
          ? "The saved worker registration permission is now shown."
          : `The operation failed (${receipt.code ?? "OPERATION_FAILED"}). Review the saved value before trying again.`,
      );
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Could not check the outcome.",
      );
    } finally {
      setChecking(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <PageSection title="Worker registration">
          <div className="flex items-start justify-between gap-4">
            <Label htmlFor="worker-registration-allowed" className="leading-6">
              Allow this account to register worker machines
            </Label>
            <Switch
              id="worker-registration-allowed"
              aria-describedby="worker-registration-help worker-registration-access"
              checked={data.workerRegistrationAllowed === true}
              disabled={
                !canManage ||
                !active ||
                Boolean(change) ||
                update.isPending ||
                Boolean(unknownOperationId)
              }
              onCheckedChange={(allowed) => {
                setNotice(null);
                setChange({
                  workerRegistrationAllowed: allowed,
                  expectedRevision: data.revision,
                  operationId: createOperationId(),
                });
              }}
            />
          </div>
          <p
            id="worker-registration-help"
            className="mt-3 text-sm text-muted-foreground"
          >
            When this person signs in with Google in MusicMute Local, an open
            and connected Mac app automatically registers and starts its worker.
            Turning this off prevents new registrations. Manage machines already
            registered from Workers.
          </p>
          <p
            id="worker-registration-access"
            className="mt-2 text-sm text-muted-foreground"
          >
            {!active
              ? "Registration is unavailable while this account is not active. The saved permission is shown above; existing machines are unaffected."
              : !canManage
                ? "Your role can view this permission but cannot change it."
                : "Approval can be saved before Google sign-in. The Mac must use a Google session for first registration."}
          </p>
          {can("workers.read") ? (
            <Button asChild variant="link" className="mt-2 px-0">
              <Link to="/workers">Manage registered machines</Link>
            </Button>
          ) : null}
        </PageSection>
        {notice ? (
          <p role={unknownOperationId ? "alert" : "status"} className="text-sm">
            {notice}
          </p>
        ) : null}
        {unknownOperationId ? (
          <Button
            variant="outline"
            disabled={checking}
            onClick={() => void checkOutcome()}
          >
            {checking ? "Checking outcome" : "Check operation outcome"}
          </Button>
        ) : null}
      </CardContent>
      <ReasonDialog
        open={Boolean(change)}
        onOpenChange={(open) => !open && setChange(null)}
        title={
          change?.workerRegistrationAllowed
            ? "Allow worker registration"
            : "Block new worker registrations"
        }
        description={
          change?.workerRegistrationAllowed
            ? "An approved Google session can automatically register each new Mac while MusicMute Local is open and connected. Existing machine controls remain authoritative."
            : "This blocks new machine registrations only. Existing machines keep running; pause, drain or revoke them from Workers."
        }
        confirmLabel="Save registration permission"
        freshAuth
        onReauthenticate={reauthenticate}
        onConfirm={(reason) => update.mutateAsync(reason).then(() => undefined)}
      />
    </Card>
  );
}
