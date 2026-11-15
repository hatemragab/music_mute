import { AlertCircle, AudioLines, LoaderCircle, RefreshCw } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { useAdminSession } from "./admin-session";

export function SignInPage() {
  const { state, error, signIn, signOut, refresh } = useAdminSession();
  const busy = state === "restoring" || state === "checkingAccess";
  const denied = state === "denied";

  return (
    <main className="relative grid min-h-svh place-items-center overflow-hidden bg-background p-4 text-foreground">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,var(--brand-glow),transparent_36%),radial-gradient(circle_at_bottom_right,var(--brand-glow-soft),transparent_32%)]" />
      <Card className="relative w-full max-w-md border-border/80 bg-card/95 shadow-2xl shadow-primary/5 backdrop-blur">
        <CardHeader className="space-y-4">
          <div className="flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/20">
            <AudioLines aria-hidden="true" className="size-6" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              MusicMute Operations
            </h1>
            <CardDescription className="mt-2 leading-relaxed">
              Sign in with an approved Google administrator account. Access is
              verified by the backend.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {error ? (
            <Alert variant="destructive" role="alert">
              <AlertCircle aria-hidden="true" />
              <AlertTitle>
                {denied ? "Access denied" : "Sign-in unavailable"}
              </AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {busy ? (
            <div
              className="flex items-center gap-3 rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground"
              aria-live="polite"
            >
              <LoaderCircle
                aria-hidden="true"
                className="size-4 animate-spin motion-reduce:animate-none"
              />
              {state === "restoring"
                ? "Restoring your session…"
                : "Checking administrator access…"}
            </div>
          ) : null}
          <div className="grid gap-2">
            {denied ? (
              <>
                <Button onClick={() => void signOut()}>
                  Use another Google account
                </Button>
                <Button variant="outline" onClick={() => void refresh()}>
                  <RefreshCw aria-hidden="true" /> Refresh access
                </Button>
              </>
            ) : (
              <Button disabled={busy} onClick={() => void signIn()}>
                Continue with Google
              </Button>
            )}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            The dashboard never grants access from a browser-side email list.
            Your current role and permissions are read from the protected admin
            session endpoint.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
