import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router";

import type { Permission } from "@/api/contracts";
import { useAdminSession } from "@/auth/admin-session";
import { LoadingState } from "@/components/page";
import { PermissionBoundary } from "@/components/permission-boundary";
import { AppShell, NAV_ITEMS } from "./app-shell";

const AdministratorsPage = lazy(() =>
  import("@/features/administrators/administrators-page").then((module) => ({
    default: module.AdministratorsPage,
  })),
);
const ActivityLogPage = lazy(() =>
  import("@/features/activity/activity-log-page").then((module) => ({
    default: module.ActivityLogPage,
  })),
);
const AccountRecoveryPage = lazy(() =>
  import("@/features/account-recovery/account-recovery-page").then(
    (module) => ({
      default: module.AccountRecoveryPage,
    }),
  ),
);
const AbuseEventsPage = lazy(() =>
  import("@/features/abuse/abuse-events-page").then((module) => ({
    default: module.AbuseEventsPage,
  })),
);
const SystemHealthPage = lazy(() =>
  import("@/features/health/system-health-page").then((module) => ({
    default: module.SystemHealthPage,
  })),
);
const JobDetailPage = lazy(() =>
  import("@/features/jobs/job-detail-page").then((module) => ({
    default: module.JobDetailPage,
  })),
);
const JobsPage = lazy(() =>
  import("@/features/jobs/jobs-page").then((module) => ({
    default: module.JobsPage,
  })),
);
const OverviewPage = lazy(() =>
  import("@/features/overview/overview-page").then((module) => ({
    default: module.OverviewPage,
  })),
);
const ReleaseDetailPage = lazy(() =>
  import("@/features/releases/release-detail-page").then((module) => ({
    default: module.ReleaseDetailPage,
  })),
);
const ReleasesPage = lazy(() =>
  import("@/features/releases/releases-page").then((module) => ({
    default: module.ReleasesPage,
  })),
);
const UpdatePolicyPage = lazy(() =>
  import("@/features/releases/update-policy-page").then((module) => ({
    default: module.UpdatePolicyPage,
  })),
);
const ProcessingSettingsPage = lazy(() =>
  import("@/features/settings/processing-settings-page").then((module) => ({
    default: module.ProcessingSettingsPage,
  })),
);
const UserDetailPage = lazy(() =>
  import("@/features/users/user-detail-page").then((module) => ({
    default: module.UserDetailPage,
  })),
);
const UsersPage = lazy(() =>
  import("@/features/users/users-page").then((module) => ({
    default: module.UsersPage,
  })),
);
const WorkerFleetPage = lazy(() =>
  import("@/features/workers/worker-fleet-page").then((module) => ({
    default: module.WorkerFleetPage,
  })),
);
const WorkerMachinePage = lazy(() =>
  import("@/features/workers/worker-machine-page").then((module) => ({
    default: module.WorkerMachinePage,
  })),
);

const Guard = ({
  permission,
  children,
}: {
  permission: Permission;
  children: ReactNode;
}) => (
  <PermissionBoundary permission={permission}>
    <Suspense fallback={<LoadingState />}>{children}</Suspense>
  </PermissionBoundary>
);

function HomeRedirect() {
  const { can } = useAdminSession();
  const first = NAV_ITEMS.find((item) => can(item.permission));
  return <Navigate to={first?.to ?? "/not-authorized"} replace />;
}

function NotFoundPage() {
  return (
    <div className="rounded-xl border bg-card p-8">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="mt-2 text-muted-foreground">
        The requested dashboard area does not exist.
      </p>
    </div>
  );
}

export function AppRouter() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomeRedirect />} />
        <Route
          path="overview"
          element={
            <Guard permission="overview.read">
              <OverviewPage />
            </Guard>
          }
        />
        <Route
          path="jobs"
          element={
            <Guard permission="jobs.read">
              <JobsPage />
            </Guard>
          }
        />
        <Route
          path="jobs/:id"
          element={
            <Guard permission="jobs.read">
              <JobDetailPage />
            </Guard>
          }
        />
        <Route
          path="users"
          element={
            <Guard permission="users.read">
              <UsersPage />
            </Guard>
          }
        />
        <Route
          path="users/:id"
          element={
            <Guard permission="users.read">
              <UserDetailPage />
            </Guard>
          }
        />
        <Route
          path="account-recovery"
          element={
            <Guard permission="users.account-recovery.manage">
              <AccountRecoveryPage />
            </Guard>
          }
        />
        <Route
          path="abuse-events"
          element={
            <Guard permission="abuse.read">
              <AbuseEventsPage />
            </Guard>
          }
        />
        <Route
          path="releases"
          element={
            <Guard permission="releases.read">
              <ReleasesPage />
            </Guard>
          }
        />
        <Route
          path="releases/:id"
          element={
            <Guard permission="releases.read">
              <ReleaseDetailPage />
            </Guard>
          }
        />
        <Route
          path="update-policy"
          element={
            <Guard permission="releases.read">
              <UpdatePolicyPage />
            </Guard>
          }
        />
        <Route
          path="settings"
          element={
            <Guard permission="settings.read">
              <ProcessingSettingsPage />
            </Guard>
          }
        />
        <Route
          path="workers"
          element={
            <Guard permission="workers.read">
              <WorkerFleetPage />
            </Guard>
          }
        />
        <Route
          path="workers/:id"
          element={
            <Guard permission="workers.read">
              <WorkerMachinePage />
            </Guard>
          }
        />
        <Route
          path="health"
          element={
            <Guard permission="health.read">
              <SystemHealthPage />
            </Guard>
          }
        />
        <Route
          path="activity"
          element={
            <Guard permission="audit.read">
              <ActivityLogPage />
            </Guard>
          }
        />
        <Route
          path="administrators"
          element={
            <Guard permission="admin.access.manage">
              <AdministratorsPage />
            </Guard>
          }
        />
        <Route
          path="not-authorized"
          element={
            <div className="rounded-xl border bg-card p-8">
              <h1 className="text-2xl font-semibold">
                No dashboard area is available
              </h1>
              <p className="mt-2 text-muted-foreground">
                Your administrator record has no permission for this route.
                Refresh the session or contact an owner.
              </p>
            </div>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
