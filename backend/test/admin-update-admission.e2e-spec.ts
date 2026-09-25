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
import { JobsService } from '../src/jobs/jobs.service.js';
import { PREPARATION_PROFILE_ID } from '../src/jobs/job.types.js';

describe('processing admission HTTP boundary', () => {
  let app: INestApplication;
  afterEach(async () => app?.close());

  it('routes validated processing-start requests to the guarded domain services', async () => {
    const query = { list: vi.fn(), detail: vi.fn(), download: vi.fn() };
    const actions = {
      cancel: vi.fn(),
      retry: vi.fn().mockResolvedValue({ status: 'queued' }),
    };
    const jobs = {
      create: vi.fn().mockResolvedValue({ status: 'awaiting_upload' }),
      renewUpload: vi.fn().mockResolvedValue({ method: 'PUT' }),
      confirmUpload: vi.fn().mockResolvedValue({ status: 'queued' }),
    };
    const module = await Test.createTestingModule({
      controllers: [JobsController],
      providers: [
        { provide: JobsQueryService, useValue: query },
        { provide: JobsService, useValue: jobs },
        { provide: JobActionsService, useValue: actions },
        { provide: JobMetadataService, useValue: { rename: vi.fn() } },
        { provide: JobDeletionService, useValue: { delete: vi.fn() } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('');
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
    const responses = [
      await request(server).post('/jobs').send({
        policyVersion: 2,
        preparationProfileId: PREPARATION_PROFILE_ID,
        source: 'audio_file',
        requestId: '14b2d476-e40e-4aeb-a8dd-24db12337695',
        input,
      }),
      await request(server)
        .post(`/jobs/${id}/retry-attempts`)
        .send({ requestId: '24b2d476-e40e-4aeb-a8dd-24db12337695' }),
      await request(server).post(`/jobs/${id}/upload-grants`).send({
        requestId: '34b2d476-e40e-4aeb-a8dd-24db12337695',
      }),
      await request(server).post(`/jobs/${id}/upload-completions`).send({}),
    ];
    expect(responses.map((response) => response.status)).toEqual([
      201, 201, 200, 200,
    ]);
    expect(jobs.create).toHaveBeenCalledOnce();
    expect(actions.retry).toHaveBeenCalledOnce();
    expect(jobs.renewUpload).toHaveBeenCalledOnce();
    expect(jobs.confirmUpload).toHaveBeenCalledOnce();
    expect(query.list).not.toHaveBeenCalled();
    expect(actions.cancel).not.toHaveBeenCalled();
  });
});
