import { useMemo } from "react";
import { createBrowserRouter, RouterProvider } from "react-router";

import { useAdminSession } from "@/auth/admin-session";
import { SignInPage } from "@/auth/sign-in-page";
import { publicConfig } from "@/config";
import { AppRouter } from "./router";

function DashboardRouter() {
  const router = useMemo(
    () =>
      createBrowserRouter([{ path: "*", element: <AppRouter /> }], {
        basename:
          publicConfig.basePath === "/"
            ? undefined
            : publicConfig.basePath.slice(0, -1),
      }),
    [],
  );
  return <RouterProvider router={router} />;
}

export function App() {
  const { state } = useAdminSession();
  if (state !== "allowed") return <SignInPage />;
  return <DashboardRouter />;
}
