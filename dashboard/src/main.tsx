import { QueryClientProvider } from "@tanstack/react-query";
import { ErrorBoundary } from "@sentry/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { queryClient } from "./app/query-client";
import { ThemeProvider } from "./app/theme";
import { AdminSessionProvider } from "./auth/admin-session";
import { Toaster } from "./components/ui/sonner";
import { TooltipProvider } from "./components/ui/tooltip";
import { initializeSentry } from "./observability/sentry";
import "./styles.css";

initializeSentry();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary
      fallback={<p>The dashboard encountered an error. Reload to retry.</p>}
    >
      <QueryClientProvider client={queryClient}>
        <AdminSessionProvider queryClient={queryClient}>
          <ThemeProvider>
            <TooltipProvider>
              <App />
              <Toaster richColors closeButton />
            </TooltipProvider>
          </ThemeProvider>
        </AdminSessionProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
