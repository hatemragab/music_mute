import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import type {
  ArgumentMetadata,
  CallHandler,
  ExecutionContext,
} from '@nestjs/common';
import {
  SnakeCaseRequestPipe,
  SnakeCaseResponseInterceptor,
} from './snake-case-wire.js';

const bodyMetadata: ArgumentMetadata = { type: 'body' };
const queryMetadata: ArgumentMetadata = { type: 'query' };

describe('snake_case HTTP contract', () => {
  const request = new SnakeCaseRequestPipe();

  it('maps nested JSON and query keys to existing internal names', () => {
    expect(
      request.transform(
        {
          request_id: 'id',
          input: { content_type: 'audio/mpeg', duration_seconds: 12 },
          items: [{ created_at: 'now' }],
        },
        bodyMetadata,
      ),
    ).toEqual({
      requestId: 'id',
      input: { contentType: 'audio/mpeg', durationSeconds: 12 },
      items: [{ createdAt: 'now' }],
    });
    expect(request.transform({ actor_uid: 'uid' }, queryMetadata)).toEqual({
      actorUid: 'uid',
    });
  });

  it('rejects legacy camelCase keys at any request depth', () => {
    expect(() =>
      request.transform({ requestId: 'id' }, bodyMetadata),
    ).toThrow();
    expect(() =>
      request.transform({ input: { contentType: 'audio/mpeg' } }, bodyMetadata),
    ).toThrow();
    expect(() =>
      request.transform({ actorUid: 'uid' }, queryMetadata),
    ).toThrow();
  });

  it('does not change route parameter names or values', () => {
    expect(request.transform({ uploadId: 'id' }, { type: 'param' })).toEqual({
      uploadId: 'id',
    });
  });

  it('maps successful response keys recursively without changing values', async () => {
    const date = new Date('2026-09-25T00:00:00.000Z');
    const response = new SnakeCaseResponseInterceptor();
    const next: CallHandler = {
      handle: () =>
        of({
          requestId: 'id',
          nextCursor: null,
          items: [{ createdAt: date, input: { contentType: 'audio/mpeg' } }],
          grant: { headers: { 'Content-Type': 'audio/mpeg' } },
          signed: {
            keyId: 'key',
            metadata: { releaseVersion: '1.0.0' },
          },
        }),
    };

    expect(
      await firstValueFrom(response.intercept({} as ExecutionContext, next)),
    ).toEqual({
      request_id: 'id',
      next_cursor: null,
      items: [{ created_at: date, input: { content_type: 'audio/mpeg' } }],
      grant: { headers: { 'Content-Type': 'audio/mpeg' } },
      signed: { key_id: 'key', metadata: { releaseVersion: '1.0.0' } },
    });
  });
});
