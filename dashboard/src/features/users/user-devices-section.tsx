import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Globe, Laptop, Smartphone } from "lucide-react";

import { useAdminSession } from "@/auth/admin-session";
import { CursorPagination } from "@/components/cursor-pagination";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageSection,
} from "@/components/page";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { countryName } from "@/features/settings/countries";
import { formatDateTime } from "@/lib/format";
import { useLiveQuery, useRealtime } from "@/realtime/hooks";
import type { AdminUserDevice } from "./user-device-types";

const platformLabels: Record<AdminUserDevice["platform"], string> = {
  android: "Android",
  ios: "iOS",
  macos: "macOS",
  windows: "Windows",
  web: "Web",
};

function countryLabel(code: string | null | undefined) {
  return code ? `${countryName(code)} (${code})` : "Unknown";
}

function DeviceField({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`mt-1 break-words ${mono ? "font-mono text-xs" : ""}`}>
        {children}
      </dd>
    </div>
  );
}

function DeviceCard({ device }: { device: AdminUserDevice }) {
  const platform = platformLabels[device.platform];
  const Icon =
    device.platform === "web"
      ? Globe
      : device.platform === "android" || device.platform === "ios"
        ? Smartphone
        : Laptop;
  const location = device.location;
  return (
    <article
      aria-label={`${device.deviceModel ?? platform} device`}
      className="rounded-xl border bg-background p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Icon
            aria-hidden="true"
            className="mt-0.5 size-5 shrink-0 text-muted-foreground"
          />
          <div className="min-w-0">
            <h3 className="break-words font-semibold">
              {device.deviceModel ?? `${platform} installation`}
            </h3>
            <p className="text-xs text-muted-foreground">
              {platform}
              {device.platform === "web"
                ? " · Browser-profile installation"
                : ""}
            </p>
          </div>
        </div>
        {device.historyHiddenAt && (
          <Badge variant="outline">Hidden from user history</Badge>
        )}
      </div>
      <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
        <DeviceField label="App version">
          Version {device.appVersion} · Build {device.buildNumber}
        </DeviceField>
        <DeviceField label="Country / city">
          {countryLabel(location?.country)}
          <span className="block text-xs text-muted-foreground">
            {location?.city ?? "City unknown"}
          </span>
        </DeviceField>
        <DeviceField label="Last seen">
          {formatDateTime(device.lastSeenAt)}
        </DeviceField>
        <DeviceField label="Session">
          <StatusBadge
            value={device.sessionStatus}
            label={
              device.sessionStatus === "signed_out" ? "Signed out" : "Unknown"
            }
          />
        </DeviceField>
      </dl>
      <details className="mt-4 border-t pt-3">
        <summary className="cursor-pointer rounded-sm text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
          View device details
        </summary>
        <div className="mt-4 space-y-5">
          <dl className="grid gap-4 text-sm sm:grid-cols-2 xl:grid-cols-3">
            <DeviceField label="Installation ID" mono>
              {device.installationId}
            </DeviceField>
            <DeviceField label="Platform">{platform}</DeviceField>
            <DeviceField label="Device model">
              {device.deviceModel ?? "Not available"}
            </DeviceField>
            <DeviceField label="Operating system version">
              {device.osVersion}
            </DeviceField>
            <DeviceField label="Metadata revision">
              {device.metadataRevision}
            </DeviceField>
            <DeviceField label="First seen">
              {formatDateTime(device.firstSeenAt)}
            </DeviceField>
            <DeviceField label="Last recorded authentication">
              {formatDateTime(device.lastAuthenticatedAt)}
            </DeviceField>
            <DeviceField label="User history visibility">
              {device.historyHiddenAt
                ? "Hidden from user history"
                : "Visible to user"}
            </DeviceField>
            <DeviceField label="History hidden at">
              {formatDateTime(device.historyHiddenAt)}
            </DeviceField>
          </dl>
          <div className="space-y-3">
            <h4 className="text-sm font-medium">Latest connection location</h4>
            {location ? (
              <dl className="grid gap-4 text-sm sm:grid-cols-2 xl:grid-cols-3">
                {Object.entries({
                  Country: countryLabel(location.country),
                  "Continent code": location.continent ?? "Unknown",
                  Region: location.region ?? "Not available",
                  "Region code": location.regionCode ?? "Not available",
                  City: location.city ?? "Unknown",
                  "Postal code": location.postalCode ?? "Not available",
                  "Metro code": location.metroCode ?? "Not available",
                  Timezone: location.timezone ?? "Not available",
                  Latitude: location.latitude ?? "Not available",
                  Longitude: location.longitude ?? "Not available",
                  "Location source": "Cloudflare",
                  "Location observed": formatDateTime(location.observedAt),
                }).map(([label, value]) => (
                  <DeviceField key={label} label={label}>
                    {value}
                  </DeviceField>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                No connection location was recorded.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <h4 className="text-sm font-medium">App version history</h4>
            <p className="text-xs text-muted-foreground">
              Up to 20 recorded app version changes.
            </p>
            {device.versionHistory.length ? (
              <Table aria-label="App version history">
                <TableCaption className="sr-only">
                  Recorded app version changes
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>Version</TableHead>
                    <TableHead>Build</TableHead>
                    <TableHead>Metadata revision</TableHead>
                    <TableHead>Observed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {device.versionHistory.map((version, index) => (
                    <TableRow key={`${version.metadataRevision}-${index}`}>
                      <TableCell>{version.appVersion}</TableCell>
                      <TableCell>{version.buildNumber}</TableCell>
                      <TableCell>{version.metadataRevision}</TableCell>
                      <TableCell>
                        {formatDateTime(version.observedAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground">
                No recorded app version changes.
              </p>
            )}
          </div>
        </div>
      </details>
    </article>
  );
}

function UserDevicesContent({ userId }: { userId: string }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const realtime = useRealtime();
  const connection = useSyncExternalStore(realtime.onState, realtime.getState);
  const devices = useLiveQuery({
    queryKey: ["user-devices", userId, cursor],
    resource: "admin.user_devices",
    params: { id: userId, before: cursor, limit: 20 },
  });
  return (
    <Card>
      <CardContent className="p-5">
        <PageSection
          title="Devices"
          description="Recorded installations for this account. Location is the latest Cloudflare-detected connection location and may differ from the user's home country. Last seen does not mean a device is currently online."
        >
          {devices.isError ? (
            <ErrorState error={devices.error} />
          ) : devices.isPending ? (
            <LoadingState rows={2} />
          ) : (
            <>
              {connection !== "live" && (
                <p
                  role="status"
                  className="text-sm text-amber-700 dark:text-amber-300"
                >
                  Live connection unavailable. These are the last received
                  device observations.
                </p>
              )}
              {devices.data && (
                <p className="text-xs text-muted-foreground">
                  Current page: {devices.data.items.length} installation
                  {devices.data.items.length === 1 ? "" : "s"} · Server
                  observation: {formatDateTime(devices.data.asOf)}
                </p>
              )}
              {devices.data?.items.length ? (
                <div className="space-y-3">
                  {devices.data.items.map((device) => (
                    <DeviceCard key={device.installationId} device={device} />
                  ))}
                </div>
              ) : (
                <EmptyState
                  title="No recorded devices"
                  description="Installations appear after the app reports device metadata. Reinstalling or clearing browser data can create another installation."
                />
              )}
            </>
          )}
          <CursorPagination
            cursor={cursor}
            nextCursor={devices.data?.nextCursor ?? null}
            pending={devices.isPending || devices.isError}
            onCursorChange={setCursor}
          />
        </PageSection>
      </CardContent>
    </Card>
  );
}

export function UserDevicesSection({ userId }: { userId: string }) {
  const { can } = useAdminSession();
  return userId && can("users.read") ? (
    <UserDevicesContent key={userId} userId={userId} />
  ) : null;
}
