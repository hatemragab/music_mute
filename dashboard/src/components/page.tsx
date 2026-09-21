import type { ReactNode } from "react";

import { AlertCircle, Inbox, LoaderCircle, RefreshCw } from "lucide-react";

import { ApiError } from "@/api/api-client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 border-b pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {title}
        </h1>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>
      ) : null}
    </header>
  );
}

export function RefreshButton({
  onRefresh,
  refreshing = false,
}: {
  onRefresh: () => void;
  refreshing?: boolean;
}) {
  return (
    <Button
      variant="outline"
      disabled={refreshing}
      onClick={onRefresh}
      aria-label={refreshing ? "Refreshing" : "Refresh"}
    >
      <RefreshCw
        aria-hidden="true"
        className={
          refreshing ? "animate-spin motion-reduce:animate-none" : undefined
        }
      />
      {refreshing ? "Refreshing…" : "Refresh"}
    </Button>
  );
}

export function PageSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section
      className="space-y-3"
      aria-labelledby={`section-${title.replace(/\s+/g, "-").toLowerCase()}`}
    >
      <div>
        <h2
          id={`section-${title.replace(/\s+/g, "-").toLowerCase()}`}
          className="text-base font-semibold text-foreground"
        >
          {title}
        </h2>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

export function LoadingState({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-label="Loading" role="status">
      <span className="sr-only">Loading</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="grid min-h-48 place-items-center rounded-xl border border-dashed bg-muted/20 p-8 text-center">
      <div>
        <Inbox
          aria-hidden="true"
          className="mx-auto mb-3 size-8 text-muted-foreground"
        />
        <h3 className="font-medium text-foreground">{title}</h3>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          {description}
        </p>
      </div>
    </div>
  );
}

export function ErrorState({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  const apiError = error instanceof ApiError ? error : null;
  const message =
    error instanceof Error
      ? error.message
      : "The request could not be completed.";
  return (
    <Alert variant="destructive" role="alert">
      <AlertCircle aria-hidden="true" />
      <AlertTitle>Could not load this data</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{message}</p>
        {apiError?.requestId ? (
          <p className="font-mono text-xs">Request {apiError.requestId}</p>
        ) : null}
        {retry ? (
          <Button size="sm" variant="outline" onClick={retry}>
            <RefreshCw aria-hidden="true" /> Try again
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

export function InlineBusy({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2" aria-live="polite">
      <LoaderCircle
        aria-hidden="true"
        className="size-4 animate-spin motion-reduce:animate-none"
      />
      {label}
    </span>
  );
}
