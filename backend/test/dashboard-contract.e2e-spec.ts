import 'reflect-metadata';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { RequestMethod, type Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { AdminAccessController } from '../src/admin/admin-access.controller.js';
import { AdminAuditController } from '../src/admin/admin-audit.controller.js';
import { AdminOperationsController } from '../src/admin/admin-operations.controller.js';
import { AdminSessionController } from '../src/admin/admin-session.controller.js';
import { AdminUsersController } from '../src/admin-users/admin-users.controller.js';
import { AdminAccountRecoveryController } from '../src/admin-users/admin-account-recovery.controller.js';
import { AdminJobsController } from '../src/admin-jobs/admin-jobs.controller.js';
import { AdminMediaController } from '../src/admin-jobs/admin-media.controller.js';
import { AdminJobsQueryService } from '../src/admin-jobs/admin-jobs-query.service.js';
import { AdminJobActionsService } from '../src/admin-jobs/admin-job-actions.service.js';
import { AdminSettingsController } from '../src/admin-settings/admin-settings.controller.js';
import { AdminReleasesController } from '../src/releases/admin-releases.controller.js';
import { AdminReleaseUploadsController } from '../src/releases/admin-release-uploads.controller.js';
import { AdminUpdatePolicyController } from '../src/releases/admin-update-policy.controller.js';
import { AdminOverviewController } from '../src/admin-observability/admin-overview.controller.js';
import { AdminHealthController } from '../src/admin-observability/admin-health.controller.js';
import { AdminAlertsController } from '../src/admin-observability/admin-alerts.controller.js';
import { AdminExportsController } from '../src/admin-exports/admin-exports.controller.js';
import { AdminWorkerEnrollmentController } from '../src/worker-fleet/enrollment/admin-worker-enrollment.controller.js';
import { AdminWorkerControlController } from '../src/worker-fleet/control/admin-worker-control.controller.js';
import { AdminAbuseProtectionController } from '../src/abuse-protection/admin-abuse-protection.controller.js';
import {
  ADMIN_FRESH_AUTH,
  ADMIN_PERMISSION,
  ADMIN_RATE_CLASS,
  ADMIN_ROUTE,
} from '../src/admin/admin.decorators.js';
import type { AdminRole } from '../src/admin/admin.types.js';
import { RateBudgetService } from '../src/rate-limits/rate-budget.service.js';
import {
  createAdminHarness,
  type AdminHarness,
} from './helpers/admin-harness.js';

interface RouteFixture {
  controller: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  permissions: string[];
  roles: AdminRole[];
  freshAuth: boolean;
  rateClass: 'read' | 'write' | 'media' | 'sensitive' | 'export';
  requestBody: Record<string, unknown> | null;
  responseCategory: string;
  validationOwner: 'dto' | 'service' | 'controller-query' | 'none';
  successStatus: number;
}
const inventory = JSON.parse(
  readFileSync(
    new URL('./fixtures/dashboard-contracts/routes.json', import.meta.url),
    'utf8',
  ),
) as { roles: AdminRole[]; routes: RouteFixture[] };
const controllers: Type[] = [
  AdminSessionController,
  AdminAccessController,
  AdminAuditController,
  AdminOperationsController,
  AdminUsersController,
  AdminAbuseProtectionController,
  AdminAccountRecoveryController,
  AdminJobsController,
  AdminMediaController,
  AdminSettingsController,
  AdminReleasesController,
  AdminReleaseUploadsController,
  AdminUpdatePolicyController,
  AdminOverviewController,
  AdminHealthController,
  AdminAlertsController,
  AdminExportsController,
  AdminWorkerEnrollmentController,
  AdminWorkerControlController,
];
const endpoint = (route: RouteFixture) =>
  route.path
    .replace(':operationId', '2bd185fb-d2d7-4c1e-82a8-63cfb6a7ed29')
    .replace(':uploadId', 'bbbbbbbbbbbbbbbbbbbbbbbb')
    .replace(':uid', 'synthetic-target-uid')
    .replace(':id', 'aaaaaaaaaaaaaaaaaaaaaaaa');
const budgetsByClass = {
  read: { limit: 120, windowMs: 60000 },
  write: { limit: 30, windowMs: 60000 },
  media: { limit: 20, windowMs: 60000 },
  sensitive: { limit: 5, windowMs: 60000 },
  export: { limit: 5, windowMs: 3600000 },
};

// This suite proves real controller/guard/pipeline reachability. Domain services
// are explicit doubles; feature and compiled integration suites own JSON data,
// database, signing, audit and lifecycle correctness.
describe('complete administration route authorization contract', () => {
  let harness: AdminHarness;
  const domainCalls: string[] = [];
  const reserve = vi.fn(async (_buckets: { key: string }[]) => ({
    allowed: true,
    retryAfterSeconds: 0,
  }));
  beforeAll(async () => {
    const services = new Set<Type>();
    for (const controller of controllers) {
      for (const dependency of (Reflect.getMetadata(
        'design:paramtypes',
        controller,
      ) ?? []) as Type[])
        services.add(dependency);
    }
    const providers = [...services].map((service) => {
      const methods = Object.getOwnPropertyNames(service.prototype).filter(
        (name) => name !== 'constructor',
      );
      const value = Object.fromEntries(
        methods.map((name) => [
          name,
          vi.fn(async () => {
            domainCalls.push(`${service.name}.${name}`);
            return name === 'export'
              ? { csv: 'fixture\r\n', filename: 'fixture.csv' }
              : { contractFixture: true };
          }),
        ]),
      );
      return { provide: service, useValue: value };
    });
    harness = await createAdminHarness({
      controllers: controllers.filter(
        (controller) => controller !== AdminSessionController,
      ),
      providers: [
        ...providers,
        { provide: RateBudgetService, useValue: { reserve } },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            ADMIN_REAUTH_MAX_AGE_SECONDS: 300,
            AUDIO_PROCESSING_ENABLED: true,
          }),
        },
      ],
    });
    await harness.app.listen(0, '127.0.0.1');
  });
  afterAll(async () => {
    await harness?.close();
  });
  beforeEach(() => {
    domainCalls.length = 0;
    reserve.mockClear();
    reserve.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    harness.identities.get('google-owner-token')!.authTimeSec = Math.floor(
      Date.now() / 1000,
    );
  });

  it('matches every actual admin controller route to the independent inventory and security metadata', () => {
    const actual: string[] = [];
    for (const controller of controllers) {
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        if (name === 'constructor') continue;
        const handler = controller.prototype[name] as object;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as
          RequestMethod | undefined;
        if (method === undefined) continue;
        const prefix = Reflect.getMetadata(PATH_METADATA, controller) as string;
        const suffix = Reflect.getMetadata(PATH_METADATA, handler) as string;
        const path = `/${prefix}/${suffix}`
          .replace(/\/+$/u, '')
          .replace(/\/+/gu, '/');
        const key = `${RequestMethod[method]} ${path}`;
        actual.push(key);
        const expected = inventory.routes.find(
          (route) => `${route.method} ${route.path}` === key,
        );
        expect(expected, key).toBeDefined();
        const metadata = (symbol: symbol) =>
          Reflect.getMetadata(symbol, handler) ??
          Reflect.getMetadata(symbol, controller);
        expect(controller.name, key).toBe(expected!.controller);
        expect(metadata(ADMIN_ROUTE), key).toBe(true);
        expect(metadata(ADMIN_PERMISSION) ?? [], key).toEqual(
          expected!.permissions,
        );
        expect(metadata(ADMIN_FRESH_AUTH) === true, key).toBe(
          expected!.freshAuth,
        );
        expect(
          metadata(ADMIN_RATE_CLASS) ??
            (method === RequestMethod.GET ? 'read' : 'write'),
          key,
        ).toBe(expected!.rateClass);
      }
    }
    expect(actual.sort()).toEqual(
      inventory.routes.map((route) => `${route.method} ${route.path}`).sort(),
    );
    expect(new Set(actual).size).toBe(actual.length);
    const discovered: string[] = [];
    function inspect(directory: string) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) inspect(path);
        else if (entry.name.endsWith('.controller.ts')) {
          const source = readFileSync(path, 'utf8');
          for (const match of source.matchAll(
            /@Controller\(['"]admin(?:\/[^'"]*)?['"]\)[\s\S]*?export class (\w+)/gu,
          ))
            discovered.push(match[1]!);
        }
      }
    }
    inspect(fileURLToPath(new URL('../src', import.meta.url)));
    expect(discovered.sort()).toEqual(
      controllers.map((controller) => controller.name).sort(),
    );
  });

  for (const route of inventory.routes) {
    it(`${route.method} ${route.path}: credentials, roles, freshness, rate limit and validation`, async () => {
      const method = route.method.toLowerCase() as
        'get' | 'post' | 'put' | 'patch' | 'delete';
      const send = (token?: string, body: unknown = route.requestBody) =>
        harness.request(method, endpoint(route), body, token);
      for (const token of [
        undefined,
        'ordinary-google-token',
        'password-token',
        'revoked-token',
      ]) {
        domainCalls.length = 0;
        const response = await send(token);
        expect(
          [401, 403],
          `${token ?? 'anonymous'} ${response.text}`,
        ).toContain(response.status);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(domainCalls).toEqual([]);
        expect(response.text).not.toMatch(/contractFixture|fixture\.csv/);
      }
      for (const role of inventory.roles) {
        domainCalls.length = 0;
        const token = harness.signInAs(role);
        const response = await send(token);
        const allowed = route.roles.includes(role);
        expect(response.status, `${role} ${response.text}`).toBe(
          allowed ? route.successStatus : 403,
        );
        expect(response.headers['cache-control']).toBe('no-store');
        if (!allowed || route.path === '/admin/session')
          expect(domainCalls).toEqual([]);
        else expect(domainCalls.length).toBe(1);
      }
      const owner = harness.signInAs('owner');
      domainCalls.length = 0;
      harness.identities.get(owner)!.authTimeSec =
        Math.floor(Date.now() / 1000) - 301;
      const stale = await send(owner);
      expect(stale.status, stale.text).toBe(
        route.freshAuth ? 403 : route.successStatus,
      );
      if (route.freshAuth) {
        expect(stale.body.code).toBe('ADMIN_REAUTH_REQUIRED');
        expect(domainCalls).toEqual([]);
      }
      harness.identities.get(owner)!.authTimeSec = Math.floor(
        Date.now() / 1000,
      );
      if (route.validationOwner === 'dto') {
        domainCalls.length = 0;
        const invalid = await send(owner, {
          ...route.requestBody,
          unrecognizedProperty: true,
        });
        expect(invalid.status, invalid.text).toBe(400);
        expect(domainCalls).toEqual([]);
        const missing = await send(owner, {});
        expect(missing.status, missing.text).toBe(400);
        expect(domainCalls).toEqual([]);
      }
      domainCalls.length = 0;
      reserve.mockClear();
      reserve.mockImplementationOnce(async () => ({
        allowed: true,
        retryAfterSeconds: 0,
      }));
      reserve.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 37 });
      const limited = await send(owner);
      expect(limited.status, limited.text).toBe(429);
      expect(limited.headers['retry-after']).toBe('37');
      expect(limited.headers['cache-control']).toBe('no-store');
      expect(domainCalls).toEqual([]);
      expect(reserve).toHaveBeenCalledWith([
        {
          key: `admin-${route.rateClass}-uid:owner-uid`,
          ...budgetsByClass[route.rateClass],
        },
        {
          key: `admin-${route.rateClass}-ip:127.0.0.1`,
          limit: 60,
          windowMs: 60_000,
        },
        {
          key: expect.stringMatching(/^admin-endpoint:[A-Za-z0-9_.]+$/u),
          limit: 300,
          windowMs: 60_000,
        },
        {
          key: 'admin-service:global',
          limit: 1_000,
          windowMs: 60_000,
        },
      ]);
    });
  }
  it('rejects unrecognized operation query fields before calling its domain service', async () => {
    const response = await harness.request(
      'get',
      '/admin/operations/2bd185fb-d2d7-4c1e-82a8-63cfb6a7ed29?cursor=invalid',
      undefined,
      harness.signInAs('owner'),
    );
    expect(response.status).toBe(400);
    expect(domainCalls).toEqual([]);
  });
  it('rejects malformed cursors, ranges and unknown job filters through real query services before database access', async () => {
    const database = { find: vi.fn(), exists: vi.fn() };
    const realQueries = new AdminJobsQueryService(
      database as never,
      database as never,
    );
    const queryHarness = await createAdminHarness({
      controllers: [AdminJobsController],
      providers: [
        { provide: AdminJobsQueryService, useValue: realQueries },
        { provide: AdminJobActionsService, useValue: {} },
      ],
    });
    try {
      await queryHarness.app.listen(0, '127.0.0.1');
      const owner = queryHarness.signInAs('owner');
      for (const path of ['/admin/jobs']) {
        for (const query of [
          'cursor=invalid',
          'limit=1000',
          'unrecognizedProperty=true',
          'from=not-a-date',
        ]) {
          const response = await queryHarness.request(
            'get',
            `${path}?${query}`,
            undefined,
            owner,
          );
          expect(response.status, response.text).toBe(400);
          expect(response.headers['cache-control']).toBe('no-store');
          expect(database.find).not.toHaveBeenCalled();
          expect(database.exists).not.toHaveBeenCalled();
        }
      }
    } finally {
      await queryHarness.close();
    }
  });
});
