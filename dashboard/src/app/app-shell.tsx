import {
  Activity,
  AudioLines,
  BriefcaseBusiness,
  ChevronRight,
  CircleGauge,
  HeartPulse,
  LogOut,
  Menu,
  Moon,
  PackageOpen,
  Settings,
  ShieldCheck,
  ShieldAlert,
  ShieldBan,
  Sun,
  Users,
  type LucideIcon,
} from "lucide-react";
import { NavLink, Outlet } from "react-router";

import type { Permission } from "@/api/contracts";
import { useAdminSession } from "@/auth/admin-session";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useTheme } from "./theme";
import { useQuery } from "@tanstack/react-query";
import { useApiClient } from "@/auth/admin-session";
import { useVisibleInterval } from "@/hooks/use-visible-interval";
import { getAccountRecoverySummary } from "@/features/account-recovery/account-recovery-api";

interface NavItem {
  label: string;
  to: string;
  permission: Permission;
  icon: LucideIcon;
  priority?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  {
    label: "Overview",
    to: "/overview",
    permission: "overview.read",
    icon: CircleGauge,
  },
  {
    label: "Jobs",
    to: "/jobs",
    permission: "jobs.read",
    icon: BriefcaseBusiness,
  },
  { label: "Users", to: "/users", permission: "users.read", icon: Users },
  {
    label: "Abuse events",
    to: "/abuse-events",
    permission: "abuse.read",
    icon: ShieldBan,
  },
  {
    label: "Account recovery",
    to: "/account-recovery",
    permission: "users.account-recovery.manage",
    icon: ShieldAlert,
    priority: true,
  },
  {
    label: "Releases",
    to: "/releases",
    permission: "releases.read",
    icon: PackageOpen,
  },
  {
    label: "Update policy",
    to: "/update-policy",
    permission: "releases.read",
    icon: ShieldCheck,
  },
  {
    label: "Settings",
    to: "/settings",
    permission: "settings.read",
    icon: Settings,
  },
  {
    label: "Health & alerts",
    to: "/health",
    permission: "health.read",
    icon: HeartPulse,
  },
  {
    label: "Activity",
    to: "/activity",
    permission: "audit.read",
    icon: Activity,
  },
  {
    label: "Administrators",
    to: "/administrators",
    permission: "admin.access.manage",
    icon: ShieldCheck,
  },
];

function Navigation({
  onNavigate,
  pendingRecoveryCount = 0,
}: {
  onNavigate?: () => void;
  pendingRecoveryCount?: number;
}) {
  const { can } = useAdminSession();
  return (
    <nav aria-label="Primary navigation" className="space-y-1">
      {NAV_ITEMS.filter((item) => can(item.permission)).map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          onClick={onNavigate}
          aria-label={
            item.priority && pendingRecoveryCount > 0
              ? `${item.label}: ${pendingRecoveryCount} pending high-priority requests`
              : item.label
          }
          className={({ isActive }) =>
            cn(
              "group flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              isActive
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )
          }
        >
          <item.icon aria-hidden="true" className="size-4 shrink-0" />
          <span>{item.label}</span>
          {item.priority && pendingRecoveryCount > 0 ? (
            <span
              className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 text-xs font-semibold text-white"
              aria-hidden="true"
              title={`${pendingRecoveryCount} pending high-priority account recovery requests`}
            >
              {pendingRecoveryCount > 99 ? "99+" : pendingRecoveryCount}
            </span>
          ) : null}
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3 opacity-0 transition-opacity group-hover:opacity-60",
              !(item.priority && pendingRecoveryCount > 0) && "ml-auto",
            )}
          />
        </NavLink>
      ))}
    </nav>
  );
}

export function AppShell() {
  const { session, signOut, can } = useAdminSession();
  const client = useApiClient();
  const { theme, toggle } = useTheme();
  const recovery = useQuery({
    queryKey: ["account-recovery-summary"],
    queryFn: () => getAccountRecoverySummary(client),
    enabled: can("users.account-recovery.manage"),
  });
  useVisibleInterval(() => {
    if (can("users.account-recovery.manage")) void recovery.refetch();
  }, 15_000);
  const pendingRecoveryCount = recovery.data?.pendingCount ?? 0;
  return (
    <div className="min-h-svh bg-background text-foreground">
      <a
        href="#main-content"
        className="fixed left-3 top-3 z-50 -translate-y-20 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground focus:translate-y-0"
      >
        Skip to content
      </a>
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r bg-sidebar lg:flex lg:flex-col">
        <div className="flex h-16 items-center gap-3 px-5">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <AudioLines aria-hidden="true" className="size-5" />
          </div>
          <div>
            <div className="font-semibold tracking-tight">MusicMute</div>
            <div className="text-xs text-muted-foreground">
              Operations console
            </div>
          </div>
        </div>
        <Separator />
        <div className="flex-1 overflow-y-auto p-3">
          <Navigation pendingRecoveryCount={pendingRecoveryCount} />
        </div>
        <Separator />
        <div className="p-4">
          <div className="truncate text-sm font-medium">
            {session?.verifiedEmail}
          </div>
          <div className="mt-1 text-xs capitalize text-muted-foreground">
            {session?.role.replaceAll("_", " ")}
          </div>
        </div>
      </aside>
      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between gap-3 border-b bg-background/90 px-4 backdrop-blur sm:px-6">
          <div className="flex items-center gap-2">
            <Sheet>
              <SheetTrigger asChild>
                <Button
                  className="lg:hidden"
                  variant="outline"
                  size="icon"
                  aria-label="Open navigation"
                >
                  <Menu aria-hidden="true" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-72 p-4">
                <SheetHeader className="mb-5">
                  <SheetTitle className="flex items-center gap-2">
                    <AudioLines aria-hidden="true" /> MusicMute Operations
                  </SheetTitle>
                </SheetHeader>
                <Navigation pendingRecoveryCount={pendingRecoveryCount} />
              </SheetContent>
            </Sheet>
            <div className="hidden items-center gap-2 text-sm text-muted-foreground sm:flex">
              <span className="size-2 rounded-full bg-emerald-500" />
              <span>Admin session active</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={toggle}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            >
              {theme === "dark" ? (
                <Sun aria-hidden="true" />
              ) : (
                <Moon aria-hidden="true" />
              )}
            </Button>
            <Button variant="outline" onClick={() => void signOut()}>
              <LogOut aria-hidden="true" />{" "}
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </header>
        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-[1600px] p-4 sm:p-6 lg:p-8"
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
