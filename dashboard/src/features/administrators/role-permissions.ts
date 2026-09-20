import type { AdminRole, Permission } from "@/api/contracts";

export const ROLE_DETAILS: Record<
  AdminRole,
  { label: string; description: string; permissions: Permission[] }
> = {
  owner: {
    label: "Owner",
    description:
      "Full operational access, administrator management, audit, settings and releases.",
    permissions: [
      "overview.read",
      "jobs.read",
      "jobs.manage",
      "users.read",
      "users.processing.manage",
      "users.restrictions.manage",
      "users.account-recovery.manage",
      "abuse.read",
      "media.read",
      "releases.read",
      "releases.manage",
      "settings.read",
      "settings.manage",
      "health.read",
      "alerts.manage",
      "audit.read",
      "exports.read",
      "admin.access.manage",
    ],
  },
  release_manager: {
    label: "Release manager",
    description:
      "Review, upload and publish application releases and update policy.",
    permissions: ["overview.read", "releases.read", "releases.manage"],
  },
  support: {
    label: "Support",
    description:
      "Inspect users and jobs, control processing access and request media grants.",
    permissions: [
      "overview.read",
      "jobs.read",
      "jobs.manage",
      "users.read",
      "users.processing.manage",
      "users.restrictions.manage",
      "users.account-recovery.manage",
      "abuse.read",
      "media.read",
      "settings.read",
      "exports.read",
    ],
  },
  viewer: {
    label: "Viewer",
    description: "Read-only operational overview, jobs, releases and settings.",
    permissions: [
      "overview.read",
      "jobs.read",
      "releases.read",
      "settings.read",
    ],
  },
};
