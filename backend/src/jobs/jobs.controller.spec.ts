import { describe, expect, it } from 'vitest';
import { AUTH_OPERATION, PROCESSING_ACCESS } from '../auth/auth.decorators.js';
import type { AuthRequest } from '../auth/auth-request.js';
import type { JobActionsService } from './job-actions.service.js';
import type { JobDeletionService } from './job-deletion.service.js';
import type { JobMetadataService } from './job-metadata.service.js';
import { JobsController } from './jobs.controller.js';
import type { JobsQueryService } from './jobs-query.service.js';
import type { JobsService } from './jobs.service.js';

const request = {
  user: { _id: { toHexString: () => 'owner-id' } },
} as AuthRequest;

function controller() {
  const jobs = {
    create: (
      ownerId: string,
      input: object,
      requestId: string,
      metadata: object,
    ) => ({
      ownerId,
      input,
      requestId,
      metadata,
    }),
    renewUpload: (ownerId: string, id: string, requestId: string) => ({
      ownerId,
      id,
      requestId,
    }),
    confirmUpload: (ownerId: string, id: string) => ({ ownerId, id }),
  } as unknown as JobsService;
  const query = {
    list: (ownerId: string, value: object) => ({ ownerId, value }),
    detail: (ownerId: string, id: string) => ({ ownerId, id }),
    download: (
      ownerId: string,
      id: string,
      artifact: string,
      requestId: string,
    ) => ({
      ownerId,
      id,
      artifact,
      requestId,
    }),
  } as unknown as JobsQueryService;
  const actions = {
    cancel: (ownerId: string, id: string) => ({ ownerId, id }),
    retry: (ownerId: string, id: string, requestId: string) => ({
      ownerId,
      id,
      requestId,
    }),
  } as unknown as JobActionsService;
  const metadata = {
    rename: (ownerId: string, id: string, displayName: string) => ({
      ownerId,
      id,
      displayName,
    }),
  } as unknown as JobMetadataService;
  const deletion = {
    delete: async (ownerId: string, id: string) => ({ ownerId, id }),
  } as unknown as JobDeletionService;
  return new JobsController(jobs, query, actions, metadata, deletion);
}

describe('JobsController burst classes', () => {
  it.each([
    ['list', 'processing-read'],
    ['detail', 'processing-read'],
    ['create', 'processing-create'],
    ['retry', 'processing-retry'],
    ['renew', 'processing-upload-grant'],
    ['confirm', 'processing-upload-confirm'],
    ['download', 'processing-download'],
    ['cancel', 'processing-cancel'],
    ['rename', 'processing-mutation'],
    ['delete', 'processing-mutation'],
  ] as const)('marks %s as %s', (method, operation) => {
    expect(
      Reflect.getMetadata(AUTH_OPERATION, JobsController.prototype[method]),
    ).toBe(operation);
  });
});

describe('JobsController processing boundary', () => {
  it.each(['create', 'retry', 'renew', 'confirm'] as const)(
    'preserves processing access protection on %s',
    (method) => {
      expect(
        Reflect.getMetadata(
          PROCESSING_ACCESS,
          JobsController.prototype[method],
        ),
      ).toBe(true);
    },
  );

  it('routes guarded mutations to the admission services', () => {
    expect(
      controller().create(request, {
        requestId: 'request-id',
        input: { bytes: 10 },
        source: 'audio_file',
      } as never),
    ).toEqual({
      ownerId: 'owner-id',
      input: { bytes: 10 },
      requestId: 'request-id',
      metadata: { source: 'audio_file' },
    });
    expect(
      controller().retry(request, 'job-id', { requestId: 'retry-id' }),
    ).toEqual({ ownerId: 'owner-id', id: 'job-id', requestId: 'retry-id' });
    expect(
      controller().renew(request, 'job-id', { requestId: 'grant-id' }),
    ).toEqual({
      ownerId: 'owner-id',
      id: 'job-id',
      requestId: 'grant-id',
    });
    expect(controller().confirm(request, 'job-id', {})).toEqual({
      ownerId: 'owner-id',
      id: 'job-id',
    });
  });

  it('keeps job history, result access, rename, cancellation, and deletion', async () => {
    const jobs = controller();

    expect(jobs.list(request, { status: 'ready' })).toEqual({
      ownerId: 'owner-id',
      value: { status: 'ready' },
    });
    expect(jobs.detail(request, 'job-id')).toEqual({
      ownerId: 'owner-id',
      id: 'job-id',
    });
    expect(
      jobs.download(request, 'job-id', {
        artifact: 'output',
        requestId: 'download-id',
      }),
    ).toEqual({
      ownerId: 'owner-id',
      id: 'job-id',
      artifact: 'output',
      requestId: 'download-id',
    });
    expect(
      jobs.rename(request, 'job-id', { displayName: 'Voice only' }),
    ).toEqual({
      ownerId: 'owner-id',
      id: 'job-id',
      displayName: 'Voice only',
    });
    expect(jobs.cancel(request, 'job-id', {})).toEqual({
      ownerId: 'owner-id',
      id: 'job-id',
    });
    await expect(jobs.delete(request, 'job-id', {})).resolves.toBeUndefined();
  });
});
