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
      "workers.read",
      "workers.manage",
      "workers.recover",
      "jobs.read",
      "jobs.manage",
      "users.read",
      "users.processing.manage",
      "users.account-recovery.manage",
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
  worker_manager: {
    label: "Worker manager",
    description:
      "Operate workers and jobs, inspect health and export operational data.",
    permissions: [
      "overview.read",
      "workers.read",
      "workers.manage",
      "workers.recover",
      "jobs.read",
      "jobs.manage",
      "settings.read",
      "health.read",
      "alerts.manage",
      "exports.read",
    ],
  },
  support: {
    label: "Support",
    description:
      "Inspect users and jobs, control processing access and request media grants.",
    permissions: [
      "overview.read",
      "workers.read",
      "jobs.read",
      "jobs.manage",
      "users.read",
      "users.processing.manage",
      "users.account-recovery.manage",
      "media.read",
      "settings.read",
      "exports.read",
    ],
  },
  viewer: {
    label: "Viewer",
    description:
      "Read-only operational overview, workers, jobs, releases and settings.",
    permissions: [
      "overview.read",
      "workers.read",
      "jobs.read",
      "releases.read",
      "settings.read",
    ],
  },
};
