import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessingAccessGuard } from '../src/app-policy/processing-access.guard.js';
import { AppPolicyService } from '../src/app-policy/app-policy.service.js';
import { defaultPolicy } from '../src/app-policy/access-policy.js';
import { DevicesService } from '../src/devices/devices.service.js';
import { JobActionsService } from '../src/jobs/job-actions.service.js';
import { JobDeletionService } from '../src/jobs/job-deletion.service.js';
import { JobMetadataService } from '../src/jobs/job-metadata.service.js';
import { JobsQueryService } from '../src/jobs/jobs-query.service.js';
import { JobsController } from '../src/jobs/jobs.controller.js';
import { JobsService } from '../src/jobs/jobs.service.js';
import { ProcessingEnabledGuard } from '../src/processing/processing-enabled.guard.js';
import type { AuthRequest } from '../src/auth/auth-request.js';

describe('mobile update processing admission boundary', () => {
  let app: INestApplication;
  afterEach(async () => app?.close());

  it('blocks new work and renewal for an outdated build but allows accepted upload confirmation', async () => {
    const policy = defaultPolicy();
    policy.platforms.android = {
      minimumBuild: 10,
      latestBuild: 10,
      downloadUrl: 'https://example.invalid/update',
    };
    const jobs = {
      create: vi.fn(),
      renewUpload: vi.fn(),
      confirmUpload: vi.fn().mockResolvedValue({
        id: '64b000000000000000000001',
        status: 'queued',
      }),
    };
    const actions = { retry: vi.fn(), cancel: vi.fn() };
    const module = await Test.createTestingModule({
      controllers: [JobsController],
      providers: [
        { provide: JobsService, useValue: jobs },
        { provide: JobsQueryService, useValue: {} },
        { provide: JobActionsService, useValue: actions },
        { provide: JobMetadataService, useValue: {} },
        { provide: JobDeletionService, useValue: {} },
        {
          provide: DevicesService,
          useValue: {
            findOwned: vi
              .fn()
              .mockResolvedValue({ platform: 'android', buildNumber: 9 }),
          },
        },
        {
          provide: AppPolicyService,
          useValue: {
            current: vi.fn().mockResolvedValue(policy),
            assertProcessingTargetAvailable: vi.fn(),
          },
        },
        { provide: APP_GUARD, useClass: ProcessingAccessGuard },
      ],
    })
      .overrideGuard(ProcessingEnabledGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use((rawRequest: Request, _response: Response, next: NextFunction) => {
      const req = rawRequest as AuthRequest;
      req.identity = { tokenEmailVerified: true } as never;
      req.user = {
        _id: new Types.ObjectId('64b000000000000000000099'),
      } as never;
      next();
    });
    await app.init();
    const server = app.getHttpServer();
    const installation = 'e183f234-ac55-4d06-9d08-b92d5d829ed8';
    const headers = { 'X-Installation-Id': installation };
    const missingDevice = await request(server)
      .post('/api/v1/jobs')
      .send({})
      .expect(409);
    expect(missingDevice.body.code).toBe('DEVICE_SYNC_REQUIRED');
    const invalidDevice = await request(server)
      .post('/api/v1/jobs')
      .set('X-Installation-Id', 'not-a-uuid')
      .send({})
      .expect(409);
    expect(invalidDevice.body.code).toBe('DEVICE_SYNC_REQUIRED');
    const blocked = await request(server)
      .post('/api/v1/jobs')
      .set(headers)
      .send({})
      .expect(403);
    expect(blocked.body.code).toBe('APP_UPDATE_REQUIRED');
    await request(server)
      .post('/api/v1/jobs/64b000000000000000000001/upload-url')
      .set(headers)
      .send({})
      .expect(403);
    await request(server)
      .post('/api/v1/jobs/64b000000000000000000001/retry')
      .set(headers)
      .send({ requestId: '14b2d476-e40e-4aeb-a8dd-24db12337695' })
      .expect(403);
    await request(server)
      .post('/api/v1/jobs/64b000000000000000000001/upload-complete')
      .send({})
      .expect(200);
    expect(jobs.confirmUpload).toHaveBeenCalledOnce();
    expect(jobs.create).not.toHaveBeenCalled();
    expect(jobs.renewUpload).not.toHaveBeenCalled();
    expect(actions.retry).not.toHaveBeenCalled();
  });
});
