import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";

import type { Permission } from "@/api/contracts";
import { useAdminSession } from "@/auth/admin-session";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function PermissionBoundary({
  permission,
  children,
}: {
  permission: Permission;
  children: ReactNode;
}) {
  const { can } = useAdminSession();
  const location = useLocation();
  if (!can(permission)) {
    if (location.pathname === "/")
      return <Navigate to="/not-authorized" replace />;
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>Not authorized</AlertTitle>
        <AlertDescription>
          Your current administrator role cannot open this area.
        </AlertDescription>
      </Alert>
    );
  }
  return children;
}
