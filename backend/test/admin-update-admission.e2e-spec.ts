import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authError } from '../src/auth/auth.errors.js';
import type { AuthRequest } from '../src/auth/auth-request.js';
import { JobActionsService } from '../src/jobs/job-actions.service.js';
import { JobDeletionService } from '../src/jobs/job-deletion.service.js';
import { JobMetadataService } from '../src/jobs/job-metadata.service.js';
import { JobsQueryService } from '../src/jobs/jobs-query.service.js';
import { JobsController } from '../src/jobs/jobs.controller.js';
import { ProcessingUnavailableService } from '../src/processing/processing-unavailable.service.js';

describe('processing clean-slate HTTP boundary', () => {
  let app: INestApplication;
  afterEach(async () => app?.close());

  it('returns 503 for every processing-start route without invoking domain services', async () => {
    const query = { list: vi.fn(), detail: vi.fn(), download: vi.fn() };
    const actions = { cancel: vi.fn() };
    const module = await Test.createTestingModule({
      controllers: [JobsController],
      providers: [
        { provide: JobsQueryService, useValue: query },
        { provide: JobActionsService, useValue: actions },
        { provide: JobMetadataService, useValue: { rename: vi.fn() } },
        { provide: JobDeletionService, useValue: { delete: vi.fn() } },
        ProcessingUnavailableService,
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use((rawRequest: Request, _response: Response, next: NextFunction) => {
      const req = rawRequest as AuthRequest;
      req.user = {
        _id: new Types.ObjectId('64b000000000000000000099'),
      } as never;
      next();
    });
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        exceptionFactory: () => authError('INVALID_INPUT'),
      }),
    );
    await app.init();
    const server = app.getHttpServer();
    const id = '64b000000000000000000001';
    const input = {
      extension: 'mp3',
      contentType: 'audio/mpeg',
      bytes: 100,
      durationSeconds: 10,
      sha256: Buffer.alloc(32).toString('base64'),
    };
    for (const response of [
      await request(server).post('/api/v1/jobs').send({
        requestId: '14b2d476-e40e-4aeb-a8dd-24db12337695',
        input,
      }),
      await request(server)
        .post(`/api/v1/jobs/${id}/retry`)
        .send({ requestId: '24b2d476-e40e-4aeb-a8dd-24db12337695' }),
      await request(server).post(`/api/v1/jobs/${id}/upload-url`).send({}),
      await request(server).post(`/api/v1/jobs/${id}/upload-complete`).send({}),
    ]) {
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('PROCESSING_UNAVAILABLE');
    }
    expect(query.list).not.toHaveBeenCalled();
    expect(actions.cancel).not.toHaveBeenCalled();
  });
});
