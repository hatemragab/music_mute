import type { ArgumentsHost } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { PublicExceptionFilter } from '../http/public-exception.filter.js';
import { adminError } from './admin-errors.js';
import { jobError } from '../jobs/job-errors.js';

function fixtureHost(url = '/admin/session') {
  const json = vi.fn();
  const response = {
    setHeader: vi.fn(),
    status: vi.fn(() => ({ json })),
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ originalUrl: url, headers: {} }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  return { host, response, json };
}

describe('administrator production error adapter', () => {
  it('preserves an explicit administrator service error and request ID', () => {
    const f = fixtureHost();
    new PublicExceptionFilter().catch(
      adminError('DEPENDENCY_UNAVAILABLE', 'fixture-request-id'),
      f.host,
    );
    expect(f.response.status).toHaveBeenCalledWith(503);
    expect(f.json).toHaveBeenCalledWith({
      type: 'about:blank',
      title: 'Service Unavailable',
      status: 503,
      code: 'DEPENDENCY_UNAVAILABLE',
      detail: 'Service unavailable',
      request_id: expect.any(String),
    });
    expect(f.response.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/problem+json',
    );
  });

  it('maps framework validation failures only on administrator routes', () => {
    const admin = fixtureHost();
    new PublicExceptionFilter().catch(
      new BadRequestException('private detail'),
      admin.host,
    );
    expect(admin.json).toHaveBeenCalledWith({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      code: 'INVALID_REQUEST',
      detail: 'Bad Request',
      request_id: expect.any(String),
    });

    const mobile = fixtureHost('/auth/session');
    new PublicExceptionFilter().catch(
      new BadRequestException('private detail'),
      mobile.host,
    );
    expect(mobile.json).toHaveBeenCalledWith({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      code: 'INVALID_INPUT',
      detail: 'Bad Request',
      request_id: expect.any(String),
    });
  });

  it.each([
    ['entity.parse.failed', 400, 'INVALID_REQUEST'],
    ['request.aborted', 400, 'INVALID_REQUEST'],
    ['request.size.invalid', 400, 'INVALID_REQUEST'],
    ['entity.too.large', 413, 'UPLOAD_TOO_LARGE'],
    ['charset.unsupported', 415, 'INVALID_REQUEST'],
    ['encoding.unsupported', 415, 'INVALID_REQUEST'],
  ])(
    'sanitizes admin body-parser error %s with HTTP %s',
    (type, status, code) => {
      const f = fixtureHost();
      const error = Object.assign(new Error('private parser detail'), { type });
      new PublicExceptionFilter().catch(error, f.host);
      expect(f.response.status).toHaveBeenCalledWith(status);
      expect(f.json).toHaveBeenCalledWith({
        type: 'about:blank',
        title:
          status === 400
            ? 'Bad Request'
            : status === 413
              ? 'Payload Too Large'
              : 'Unsupported Media Type',
        status,
        code,
        detail:
          code === 'UPLOAD_TOO_LARGE'
            ? 'Upload too large'
            : 'Invalid request body',
        request_id: expect.any(String),
      });
    },
  );
});

describe('public job problem details', () => {
  it('reports period quota exhaustion as a conflict with its reset time', () => {
    const f = fixtureHost('/jobs/68c000000000000000000001/upload-grants');
    const nextResetAt = '2026-10-01T00:00:00.000Z';
    new PublicExceptionFilter().catch(
      jobError('UPLOAD_GRANT_LIMIT_REACHED', { nextResetAt }),
      f.host,
    );
    expect(f.response.status).toHaveBeenCalledWith(409);
    expect(f.response.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/problem+json',
    );
    expect(f.json).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'about:blank',
        status: 409,
        code: 'UPLOAD_GRANT_LIMIT_REACHED',
        next_reset_at: nextResetAt,
      }),
    );
    expect(f.response.setHeader).not.toHaveBeenCalledWith(
      'Retry-After',
      expect.anything(),
    );
  });
});
