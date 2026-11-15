import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerEnrollmentController } from '../src/worker-fleet/enrollment/worker-enrollment.controller.js';
import { WorkerEnrollmentService } from '../src/worker-fleet/enrollment/worker-enrollment.service.js';
import { WorkerInstallationArtifactsService } from '../src/worker-fleet/enrollment/worker-installation-artifacts.service.js';
import { WorkerInstallationQualificationService } from '../src/worker-fleet/enrollment/worker-installation-qualification.service.js';
import { WorkerDiagnosticsService } from '../src/worker-fleet/telemetry/worker-diagnostics.service.js';
import { WorkerAuthGuard } from '../src/worker-fleet/auth/worker-auth.guard.js';
import {
  SnakeCaseRequestPipe,
  SnakeCaseResponseInterceptor,
} from '../src/http/snake-case-wire.js';
import { PublicExceptionFilter } from '../src/http/public-exception.filter.js';
import {
  QUALIFIED_MODEL_BYTES,
  QUALIFIED_MODEL_DIGEST,
} from '../src/jobs/worker-recipes.js';

const id = 'bfcd61be-0dd8-47af-889e-5c4aa035fa84',
  credential = 'i'.repeat(43),
  path = `/worker/installations/${id}/store-qualification-artifacts`;
describe('Store qualification data HTTP policy', () => {
  let app: INestApplication | undefined, root: string | undefined;
  afterEach(async () => {
    await app?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });
  async function setup() {
    root = await mkdtemp(join(tmpdir(), 'worker-store-data-http-'));
    const file = join(root, 'catalog.json');
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        releases: {},
        model: {
          filename: 'Kim_Vocal_2.onnx',
          bytes: QUALIFIED_MODEL_BYTES,
          sha256: QUALIFIED_MODEL_DIGEST,
          contentType: 'application/octet-stream',
          url: 'https://github.com/model/Kim_Vocal_2.onnx',
          sourcePolicy: 'direct-owner-source-only',
          allowedHosts: ['github.com'],
          maxRedirects: 2,
        },
        fixture: {
          filename: 'qualification.wav',
          key: 'worker-installation-artifacts/fixtures/qualification.wav',
          etag: '"fixture"',
          bytes: 303,
          sha256: 'ab'.repeat(32),
          contentType: 'audio/wav',
        },
      }),
    );
    const config = new ConfigService({
        WORKER_INSTALLATION_CATALOG_PATH: file,
      }),
      transfers = {
        createDownloadGrant: vi.fn(async () => ({
          url: 'https://storage.example.invalid/fixture',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        })),
      },
      artifacts = new WorkerInstallationArtifactsService(
        config,
        transfers as never,
      ),
      installation = {
        _id: id,
        phase: 'restricted',
        expiresAt: new Date(Date.now() + 60_000),
      },
      installations = {
        findOne: (filter: { credentialDigest: string }) => ({
          maxTimeMS: () => ({
            lean: async () =>
              filter.credentialDigest ===
              createHash('sha256').update(credential).digest('hex')
                ? installation
                : null,
          }),
        }),
      },
      budgets = {
        reserve: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
      },
      keys = {
        bucket: (kind: string, subject: string) => `${kind}:${subject}`,
      },
      missing = {
        findOne: () => ({ maxTimeMS: () => ({ lean: async () => null }) }),
      };
    const guard = new WorkerAuthGuard(
      new Reflector(),
      missing as never,
      installations as never,
      missing as never,
      budgets as never,
      keys as never,
      config,
    );
    const module = await Test.createTestingModule({
      controllers: [WorkerEnrollmentController],
      providers: [
        { provide: WorkerInstallationArtifactsService, useValue: artifacts },
        { provide: WorkerEnrollmentService, useValue: {} },
        { provide: WorkerInstallationQualificationService, useValue: {} },
        { provide: WorkerDiagnosticsService, useValue: {} },
      ],
    })
      .overrideGuard(WorkerAuthGuard)
      .useValue(guard)
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new SnakeCaseRequestPipe(),
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalInterceptors(new SnakeCaseResponseInterceptor());
    app.useGlobalFilters(new PublicExceptionFilter());
    await app.init();
    return {
      http: request(app.getHttpServer()),
      transfers,
      installation,
      budgets,
    };
  }
  it('returns no-store snake_case data using the existing installation auth and transfer budget with no ZIP configured', async () => {
    const f = await setup(),
      response = await f.http
        .post(path)
        .set('Authorization', `Bearer ${credential}`)
        .send({})
        .expect(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(Object.keys(response.body).sort()).toEqual([
      'fixture',
      'installation_profile',
      'model',
      'platform',
      'purpose',
      'schema_version',
    ]);
    expect(response.body.model).toMatchObject({
      filename: 'Kim_Vocal_2.onnx',
      bytes: QUALIFIED_MODEL_BYTES,
      sha256: QUALIFIED_MODEL_DIGEST,
      source_policy: 'direct-owner-source-only',
    });
    expect(f.transfers.createDownloadGrant).toHaveBeenCalledTimes(1);
    expect(f.budgets.reserve).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ key: `worker-transfer:installation:${id}` }),
      ]),
    );
  });
  it('rejects missing, malformed, expired and failed installation credentials and another installation path', async () => {
    const f = await setup();
    await f.http.post(path).send({}).expect(401);
    await f.http
      .post(path)
      .set('Authorization', 'Bearer invalid')
      .send({})
      .expect(401);
    await f.http
      .post(path.replace(id, 'cba6ea01-1db0-4f59-a082-fd3360ed332d'))
      .set('Authorization', `Bearer ${credential}`)
      .send({})
      .expect(404);
    f.installation.expiresAt = new Date(0);
    await f.http
      .post(path)
      .set('Authorization', `Bearer ${credential}`)
      .send({})
      .expect(410);
    f.installation.expiresAt = new Date(Date.now() + 60_000);
    f.installation.phase = 'failed';
    await f.http
      .post(path)
      .set('Authorization', `Bearer ${credential}`)
      .send({})
      .expect(401);
    expect(f.transfers.createDownloadGrant).not.toHaveBeenCalled();
  });
  it('rejects body overrides and rate-limited requests before any storage grant', async () => {
    const f = await setup();
    for (const body of [
      { platform: 'darwin-arm64' },
      { installation_profile: 'windows-user' },
      { release: { url: 'https://example.invalid/runtime.zip' } },
      [],
    ])
      await f.http
        .post(path)
        .set('Authorization', `Bearer ${credential}`)
        .send(body)
        .expect(400);
    f.budgets.reserve.mockClear();
    f.budgets.reserve
      .mockResolvedValueOnce({ allowed: true, retryAfterSeconds: 0 })
      .mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 4 });
    const response = await f.http
      .post(path)
      .set('Authorization', `Bearer ${credential}`)
      .send({})
      .expect(429);
    expect(response.headers['retry-after']).toBe('4');
    expect(f.budgets.reserve).toHaveBeenCalledTimes(2);
    expect(f.budgets.reserve).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ key: `worker-transfer:installation:${id}` }),
      ]),
    );
    expect(f.transfers.createDownloadGrant).not.toHaveBeenCalled();
  });
});
