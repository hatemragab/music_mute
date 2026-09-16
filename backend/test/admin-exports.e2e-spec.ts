import { afterEach, describe, expect, it, vi } from 'vitest';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AdminExportsController } from '../src/admin-exports/admin-exports.controller.js';
import { AdminExportsService } from '../src/admin-exports/admin-exports.service.js';
import { adminError } from '../src/admin/admin-errors.js';
import {
  createAdminHarness,
  type AdminHarness,
} from './helpers/admin-harness.js';

describe('CSV export HTTP boundary', () => {
  let harness: AdminHarness;
  afterEach(async () => harness?.close());
  async function setup() {
    const exports = {
      export: vi.fn(
        async (
          _actor: unknown,
          _dataset: unknown,
          _raw: unknown,
          _signal?: AbortSignal,
        ) => ({
          csv: 'id,userId\r\n"one","two"\r\n',
          filename: 'jobs-2026-09-11T00-00-00-000Z.csv',
        }),
      ),
    };
    harness = await createAdminHarness({
      controllers: [AdminExportsController],
      providers: [{ provide: AdminExportsService, useValue: exports }],
    });
    return exports;
  }
  it('requires exports plus dataset permission and returns UTF-8 attachments without cache', async () => {
    const exports = await setup();
    for (const role of ['owner', 'support'] as const) {
      const token = harness.signInAs(role);
      for (const dataset of ['jobs', 'overview']) {
        const result = await harness
          .request('get', `/admin/exports/${dataset}.csv`, undefined, token)
          .expect(200);
        expect(result.headers['content-type']).toBe('text/csv; charset=utf-8');
        expect(result.headers['cache-control']).toBe('no-store');
        expect(result.headers['content-disposition']).toMatch(
          /^attachment; filename="jobs-[A-Za-z0-9.-]+\.csv"$/,
        );
      }
    }
    for (const role of ['viewer', 'release_manager'] as const) {
      for (const dataset of ['jobs', 'overview'])
        await harness
          .request(
            'get',
            `/admin/exports/${dataset}.csv`,
            undefined,
            harness.signInAs(role),
          )
          .expect(403);
    }
    expect(exports.export).toHaveBeenCalledTimes(6);
  });
  it('fails before CSV headers or bytes on cap/audit errors and rejects revoked sessions', async () => {
    const exports = await setup();
    const token = harness.signInAs('support');
    exports.export.mockRejectedValueOnce(adminError('EXPORT_TOO_LARGE'));
    const tooLarge = await harness
      .request('get', '/admin/exports/jobs.csv', undefined, token)
      .expect(422);
    expect(tooLarge.body.code).toBe('EXPORT_TOO_LARGE');
    expect(tooLarge.headers['content-disposition']).toBeUndefined();
    expect(tooLarge.headers['content-type']).toContain('application/json');
    exports.export.mockRejectedValueOnce(
      new Error('private audit unavailable'),
    );
    const failure = await harness
      .request('get', '/admin/exports/jobs.csv', undefined, token)
      .expect(503);
    expect(failure.headers['content-disposition']).toBeUndefined();
    expect(JSON.stringify(failure.body)).not.toContain('private audit');
    harness.identities.get(token)!.revoked = true;
    await harness
      .request('get', '/admin/exports/jobs.csv', undefined, token)
      .expect(401);
    expect(exports.export).toHaveBeenCalledTimes(2);
  });
  it('propagates a real HTTP client disconnect to the export acquisition signal', async () => {
    const exports = await setup();
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const entered = deferred();
    const disconnected = deferred();
    exports.export.mockImplementationOnce(
      async (_actor, _dataset, _raw, signal) => {
        entered.resolve();
        return new Promise((_resolve, reject) =>
          signal!.addEventListener(
            'abort',
            () => {
              disconnected.resolve();
              reject(new Error('Client disconnected'));
            },
            { once: true },
          ),
        );
      },
    );
    await harness.app.listen(0, '127.0.0.1');
    const port = (harness.app.getHttpServer().address() as AddressInfo).port;
    const request = get({
      host: '127.0.0.1',
      port,
      path: '/api/v1/admin/exports/jobs.csv',
      headers: { Authorization: `Bearer ${harness.signInAs('support')}` },
    });
    request.on('error', () => undefined);
    await entered.promise;
    request.destroy();
    await disconnected.promise;
    expect(exports.export).toHaveBeenCalledOnce();
  });
});
