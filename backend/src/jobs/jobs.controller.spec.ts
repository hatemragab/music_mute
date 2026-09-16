import { describe, expect, it } from 'vitest';
import { AUTH_OPERATION, PROCESSING_ACCESS } from '../auth/auth.decorators.js';
import type { AuthRequest } from '../auth/auth-request.js';
import { ProcessingUnavailableService } from '../processing/processing-unavailable.service.js';
import type { JobActionsService } from './job-actions.service.js';
import type { JobDeletionService } from './job-deletion.service.js';
import type { JobMetadataService } from './job-metadata.service.js';
import { JobsController } from './jobs.controller.js';
import type { JobsQueryService } from './jobs-query.service.js';

const request = {
  user: { _id: { toHexString: () => 'owner-id' } },
} as AuthRequest;

function controller() {
  const query = {
    list: (ownerId: string, value: object) => ({ ownerId, value }),
    detail: (ownerId: string, id: string) => ({ ownerId, id }),
    download: (ownerId: string, id: string, artifact: string) => ({
      ownerId,
      id,
      artifact,
    }),
  } as unknown as JobsQueryService;
  const actions = {
    cancel: (ownerId: string, id: string) => ({ ownerId, id }),
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
  return new JobsController(
    query,
    actions,
    metadata,
    deletion,
    new ProcessingUnavailableService(),
  );
}

describe('JobsController burst classes', () => {
  it.each([
    ['list', 'processing-read'],
    ['detail', 'processing-read'],
    ['create', 'processing-create'],
    ['retry', 'processing-create'],
    ['renew', 'processing-grant'],
    ['confirm', 'processing-grant'],
    ['download', 'processing-grant'],
    ['cancel', 'processing-mutation'],
    ['rename', 'processing-mutation'],
    ['delete', 'processing-mutation'],
  ] as const)('marks %s as %s', (method, operation) => {
    expect(
      Reflect.getMetadata(AUTH_OPERATION, JobsController.prototype[method]),
    ).toBe(operation);
  });
});

describe('JobsController clean-slate boundary', () => {
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

  it.each([
    ['create', () => controller().create(request, {} as never)],
    ['retry', () => controller().retry(request, 'job-id', {} as never)],
    ['renew', () => controller().renew(request, 'job-id', {})],
    ['confirm', () => controller().confirm(request, 'job-id', {})],
  ])('%s rejects before processing state can be created', (_name, invoke) => {
    try {
      invoke();
      throw new Error('expected processing route to throw');
    } catch (error) {
      expect((error as { getResponse(): unknown }).getResponse()).toMatchObject(
        {
          code: 'PROCESSING_UNAVAILABLE',
        },
      );
    }
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
    expect(jobs.download(request, 'job-id', { artifact: 'output' })).toEqual({
      ownerId: 'owner-id',
      id: 'job-id',
      artifact: 'output',
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
