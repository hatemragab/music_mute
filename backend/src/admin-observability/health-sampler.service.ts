import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { Redis } from 'ioredis';
import type { Connection, Model } from 'mongoose';
import { setTimeout as delay } from 'node:timers/promises';
import { SECURITY_REDIS } from '../rate-limits/security-redis.provider.js';
import { Release } from '../releases/release.schema.js';
import { StoragePreflightService } from '../storage/storage-preflight.service.js';
import type { AlertCondition } from './admin-alerts.service.js';
import { AdminAlertsService } from './admin-alerts.service.js';
import type { AlertType } from './admin-alert.schema.js';

export type HealthComponentStatus =
  'unknown' | 'healthy' | 'degraded' | 'unavailable';

export interface HealthComponent {
  name: 'api' | 'mongodb' | 'redis' | 'storage';
  status: HealthComponentStatus;
  checkedAt: string | null;
  code: string | null;
}

export interface HealthSnapshot {
  status: HealthComponentStatus;
  asOf: string | null;
  components: HealthComponent[];
  activeAlertCount: number | null;
}

const COMPONENTS: HealthComponent['name'][] = [
  'api',
  'mongodb',
  'redis',
  'storage',
];
const CACHE_MS = 30_000;
const PROBE_MS = 2_000;

@Injectable()
export class HealthSamplerService {
  private current: HealthSnapshot = {
    status: 'unknown',
    asOf: null,
    components: COMPONENTS.map((name) => ({
      name,
      status: 'unknown',
      checkedAt: null,
      code: null,
    })),
    activeAlertCount: null,
  };
  private sampledAtMs = 0;
  private inFlight: Promise<HealthSnapshot> | null = null;

  constructor(
    @InjectConnection() private readonly database: Connection,
    @Inject(SECURITY_REDIS) private readonly redis: Redis,
    private readonly storage: StoragePreflightService,
    @InjectModel(Release.name) private readonly releases: Model<Release>,
    private readonly alerts: AdminAlertsService,
  ) {}

  snapshot(): HealthSnapshot {
    return structuredClone(this.current);
  }

  sample(): Promise<HealthSnapshot> {
    if (this.sampledAtMs && Date.now() - this.sampledAtMs < CACHE_MS)
      return Promise.resolve(this.snapshot());
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.collect().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async collect(): Promise<HealthSnapshot> {
    const now = new Date();
    const checkedAt = now.toISOString();
    const conditions: AlertCondition[] = [];
    const observedTypes = new Set<AlertType>();
    const components = new Map<HealthComponent['name'], HealthComponent>();
    components.set('api', this.component('api', 'healthy', checkedAt));

    const [mongodb, redis, storage, releases] = await Promise.all([
      this.probe('mongodb', async () => {
        if (this.database.readyState !== 1 || !this.database.db)
          throw new Error('not connected');
        await this.database.db.command({ ping: 1 }, { timeoutMS: PROBE_MS });
      }),
      this.probe('redis', () => this.redis.ping()),
      this.probe('storage', () => this.storage.assertReady()),
      this.readRejectedReleases(),
    ]);

    for (const result of [mongodb, redis, storage]) {
      components.set(result.component.name, result.component);
      if (result.component.status === 'unavailable')
        conditions.push({
          type: 'dependency_probe_failed',
          severity: 'critical',
          resourceId: result.component.name,
          message: `${result.component.name} dependency probe failed`,
        });
      observedTypes.add('dependency_probe_failed');
    }

    if (releases.ok) {
      observedTypes.add('apk_rejected');
      for (const release of releases.value)
        conditions.push({
          type: 'apk_rejected',
          severity: 'warning',
          resourceId: String(release._id),
          message: 'APK verification was rejected',
        });
    } else {
      conditions.push({
        type: 'dependency_probe_failed',
        severity: 'critical',
        resourceId: 'releases',
        message: 'Release dependency probe failed',
      });
      observedTypes.add('dependency_probe_failed');
    }

    try {
      await this.bounded(() =>
        this.alerts.reconcile(conditions, [...observedTypes], now),
      );
    } catch {
      components.set(
        'mongodb',
        this.component(
          'mongodb',
          'unavailable',
          checkedAt,
          'ALERT_PERSISTENCE_UNAVAILABLE',
        ),
      );
    }
    let activeAlertCount: number | null = null;
    try {
      activeAlertCount = await this.bounded(() => this.alerts.countActive());
    } catch {
      // Alert count is informative; dependency component results remain valid.
    }
    const ordered = COMPONENTS.map((name) => components.get(name)!);
    this.current = {
      status: this.overallStatus(ordered),
      asOf: checkedAt,
      components: ordered,
      activeAlertCount,
    };
    this.sampledAtMs = Date.now();
    return this.snapshot();
  }

  private async probe(
    name: 'mongodb' | 'redis' | 'storage',
    operation: () => Promise<unknown>,
  ) {
    const checkedAt = new Date().toISOString();
    try {
      await this.bounded(operation);
      return { component: this.component(name, 'healthy', checkedAt) };
    } catch {
      return {
        component: this.component(
          name,
          'unavailable',
          checkedAt,
          'DEPENDENCY_UNAVAILABLE',
        ),
      };
    }
  }

  private async readRejectedReleases(): Promise<
    { ok: true; value: Pick<Release, '_id'>[] } | { ok: false }
  > {
    try {
      const value = await this.bounded(() =>
        this.releases
          .find({ platform: 'android', artifactState: 'rejected' })
          .select({ _id: 1 })
          .maxTimeMS(PROBE_MS)
          .lean(),
      );
      return { ok: true, value };
    } catch {
      return { ok: false };
    }
  }

  private async bounded<T>(operation: () => Promise<T>): Promise<T> {
    const controller = new AbortController();
    try {
      return await Promise.race([
        operation(),
        delay(PROBE_MS, undefined, { signal: controller.signal }).then(() => {
          throw new Error('probe timeout');
        }),
      ]);
    } finally {
      controller.abort();
    }
  }

  private component(
    name: HealthComponent['name'],
    status: HealthComponentStatus,
    checkedAt: string,
    code: string | null = null,
  ): HealthComponent {
    return { name, status, checkedAt, code };
  }

  private overallStatus(components: HealthComponent[]) {
    if (components.some((item) => item.status === 'unavailable'))
      return 'unavailable' as const;
    if (components.some((item) => item.status === 'degraded'))
      return 'degraded' as const;
    if (components.some((item) => item.status === 'unknown'))
      return 'unknown' as const;
    return 'healthy' as const;
  }
}
