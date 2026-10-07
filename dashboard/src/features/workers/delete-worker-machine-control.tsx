import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";

import {
  ApiError,
  createOperationId,
  OperationOutcomeUnknownError,
} from "@/api/api-client";
import type {
  OperationReceipt,
  UserDetail,
  UserSummary,
} from "@/api/contracts";
import { useAdminSession, useApiClient } from "@/auth/admin-session";
import { ReasonDialog } from "@/components/reason-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getUser, listUsers } from "@/features/users/users-api";
import { deleteWorkerMachine } from "./worker-api";
import type { WorkerMachine } from "./worker-types";

interface Review {
  machine: WorkerMachine;
  operationId: string;
  user: UserDetail | null;
  missingCreator: boolean;
  loading: boolean;
  error: string | null;
  results: UserSummary[];
  searched: boolean;
}

export function DeleteWorkerMachineControl({
  machine,
  disabled,
  onBlockedChange,
}: {
  machine: WorkerMachine | null;
  disabled: boolean;
  onBlockedChange(blocked: boolean): void;
}) {
  const client = useApiClient();
  const { can, reauthenticate } = useAdminSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [review, setReview] = useState<Review | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [unknown, setUnknown] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const allowed =
    can("workers.manage") &&
    can("users.read") &&
    can("users.worker-registration.manage");
  const complete = () => {
    void queryClient
      .invalidateQueries({ queryKey: ["worker-machines"] })
      .catch(() => undefined);
    setOpen(false);
    setUnknown(null);
    setReview(null);
    navigate("/workers", { replace: true });
  };
  const deletion = useMutation({
    mutationFn: async (reason: string) => {
      if (
        !allowed ||
        !review ||
        unknown ||
        review.loading ||
        review.error ||
        (!review.user && !review.missingCreator)
      )
        throw new Error(
          "Review the registration account before deleting this machine.",
        );
      return deleteWorkerMachine(client, review.machine.machineId, {
        operationId: review.operationId,
        expectedRevision: review.machine.revision,
        reason,
        registrationUserId:
          review.user?.id ?? review.machine.registeredByUserId ?? undefined,
        ...(review.user ? { expectedUserRevision: review.user.revision } : {}),
      });
    },
    onSuccess: complete,
    onError: (error) => {
      if (error instanceof OperationOutcomeUnknownError) {
        setUnknown(error.operationId);
        setOpen(false);
        setNotice(
          "Deletion outcome is unresolved. Check its operation outcome before making another change.",
        );
      } else if (error instanceof ApiError && error.status === 409) {
        setOpen(false);
        setReview(null);
        setNotice(
          "The machine or account changed. Review the current values before deleting.",
        );
      }
    },
  });
  useEffect(() => {
    onBlockedChange(deletion.isPending || Boolean(unknown));
  }, [deletion.isPending, unknown, onBlockedChange]);

  const loadAccount = async (
    operationId: string,
    userId: string,
    knownCreator: boolean,
  ) => {
    setReview((current) =>
      current?.operationId === operationId
        ? {
            ...current,
            user: null,
            loading: true,
            error: null,
            missingCreator: false,
          }
        : current,
    );
    try {
      const user = await getUser(client, userId);
      if (
        user.id !== userId ||
        !Number.isSafeInteger(user.revision) ||
        user.revision < 0 ||
        typeof user.workerRegistrationAllowed !== "boolean"
      )
        throw new Error("The account response could not be verified.");
      setReview((current) =>
        current?.operationId === operationId
          ? { ...current, user, loading: false }
          : current,
      );
    } catch (error) {
      setReview((current) =>
        current?.operationId === operationId
          ? {
              ...current,
              loading: false,
              missingCreator:
                knownCreator &&
                error instanceof ApiError &&
                error.status === 404,
              error:
                knownCreator &&
                error instanceof ApiError &&
                error.status === 404
                  ? null
                  : "The selected account could not be loaded. Choose an existing account before deleting.",
            }
          : current,
      );
    }
  };
  const begin = () => {
    if (!machine || disabled || unknown || deletion.isPending || !allowed)
      return;
    const operationId = createOperationId();
    setReview({
      machine: structuredClone(machine),
      operationId,
      user: null,
      missingCreator: false,
      loading: Boolean(machine.registeredByUserId),
      error: null,
      results: [],
      searched: false,
    });
    setQuery("");
    setNotice(null);
    setOpen(true);
    if (machine.registeredByUserId)
      void loadAccount(operationId, machine.registeredByUserId, true);
  };
  const search = async () => {
    if (!review || !query.trim() || review.loading) return;
    const operationId = review.operationId;
    setReview({ ...review, loading: true, error: null });
    try {
      const result = await listUsers(client, { query: query.trim() });
      setReview((current) =>
        current?.operationId === operationId
          ? {
              ...current,
              results: result.items,
              loading: false,
              searched: true,
            }
          : current,
      );
    } catch {
      setReview((current) =>
        current?.operationId === operationId
          ? {
              ...current,
              loading: false,
              error: "Account search failed. Try the search again.",
            }
          : current,
      );
    }
  };
  const checkOutcome = async () => {
    if (!unknown || !review || checking) return;
    setChecking(true);
    try {
      const receipt = await client.get<OperationReceipt>(
        `/admin/operations/${encodeURIComponent(unknown)}`,
      );
      if (
        receipt.operationId !== unknown ||
        (receipt.status === "succeeded" &&
          receipt.resourceId !== review.machine.machineId)
      )
        throw new Error("The operation response does not match this deletion.");
      if (receipt.status === "succeeded") await complete();
      else if (receipt.status === "failed") {
        setUnknown(null);
        setReview(null);
        setNotice(
          `Deletion failed (${receipt.code ?? "OPERATION_FAILED"}). Review the current values before trying again.`,
        );
      } else
        setNotice(
          "Deletion is still pending. Check its operation outcome again.",
        );
    } catch {
      setNotice(
        "The deletion outcome could not be read. Further deletion requests remain blocked.",
      );
    } finally {
      setChecking(false);
    }
  };
  if (!allowed) return null;
  return (
    <div className="space-y-3">
      {machine ? (
        <Button
          variant="destructive"
          disabled={disabled || deletion.isPending || Boolean(unknown)}
          onClick={begin}
        >
          <Trash2 aria-hidden="true" /> Delete machine
        </Button>
      ) : null}
      {notice ? (
        <p role={unknown ? "alert" : "status"} className="break-words text-sm">
          {notice}
        </p>
      ) : null}
      {unknown ? (
        <Button
          variant="outline"
          disabled={checking}
          onClick={() => void checkOutcome()}
        >
          Check deletion outcome
        </Button>
      ) : null}
      <ReasonDialog
        open={open && Boolean(review)}
        onOpenChange={(value) => {
          if (!deletion.isPending) {
            setOpen(value);
            if (!value) setReview(null);
          }
        }}
        title="Delete worker machine"
        description="Stop this machine, remove it from Workers and turn off worker registration for the account shown below. Local models and personal history stay on the Mac. A later approval allows a fresh registration."
        confirmLabel="Confirm deletion"
        destructive
        freshAuth
        confirmDisabled={
          !review ||
          review.loading ||
          Boolean(review.error) ||
          (!review.user && !review.missingCreator)
        }
        onReauthenticate={reauthenticate}
        onConfirm={async (reason) => {
          await deletion.mutateAsync(reason);
        }}
        summary={
          review ? (
            <div className="space-y-3">
              <p className="break-all">
                {review.machine.label} · {review.machine.machineId} · machine
                revision {review.machine.revision}
              </p>
              {review.machine.registeredByUserId ? (
                <p className="break-all">
                  Registered account: {review.machine.registeredByUserId}. This
                  account cannot be changed.
                </p>
              ) : (
                <>
                  <p>
                    This is a legacy registration. Select the existing account
                    whose registration approval should be turned off.
                  </p>
                  <form
                    className="flex flex-wrap gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void search();
                    }}
                  >
                    <Input
                      aria-label="Search registration account"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      maxLength={200}
                    />
                    <Button
                      type="submit"
                      variant="outline"
                      disabled={review.loading || !query.trim()}
                    >
                      Search accounts
                    </Button>
                  </form>
                  {review.results.map((user) => (
                    <Button
                      key={user.id}
                      className="h-auto whitespace-normal text-left"
                      variant="outline"
                      disabled={review.loading}
                      onClick={() =>
                        void loadAccount(review.operationId, user.id, false)
                      }
                    >
                      Select {user.email ?? user.displayName ?? user.id}
                    </Button>
                  ))}
                  {review.searched &&
                  !review.loading &&
                  !review.results.length ? (
                    <p>No accounts match this search.</p>
                  ) : null}
                </>
              )}
              {review.loading ? <p role="status">Loading account…</p> : null}
              {review.error ? <p role="alert">{review.error}</p> : null}
              {review.user ? (
                <p className="break-all">
                  Selected account:{" "}
                  {review.user.email ??
                    review.user.displayName ??
                    review.user.id}{" "}
                  · {review.user.id} · account revision {review.user.revision}.
                  Worker registration is{" "}
                  {review.user.workerRegistrationAllowed
                    ? "allowed and will be turned off"
                    : "already off and will stay off"}
                  .
                </p>
              ) : null}
              {review.missingCreator ? (
                <p>
                  The registered account no longer exists. Delete this machine
                  without changing an account approval.
                </p>
              ) : null}
            </div>
          ) : undefined
        }
      />
    </div>
  );
}
