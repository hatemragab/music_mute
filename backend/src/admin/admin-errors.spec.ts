import type { ArgumentsHost } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { PublicExceptionFilter } from '../http/public-exception.filter.js';
import { adminError } from './admin-errors.js';

function fixtureHost(url = '/api/v1/admin/session') {
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
      code: 'DEPENDENCY_UNAVAILABLE',
      message: 'Service unavailable',
      requestId: 'fixture-request-id',
    });
  });

  it('maps framework validation failures only on administrator routes', () => {
    const admin = fixtureHost();
    new PublicExceptionFilter().catch(
      new BadRequestException('private detail'),
      admin.host,
    );
    expect(admin.json).toHaveBeenCalledWith({
      code: 'INVALID_REQUEST',
      message: 'Invalid request',
      requestId: expect.any(String),
    });

    const mobile = fixtureHost('/api/v1/auth/session');
    new PublicExceptionFilter().catch(
      new BadRequestException('private detail'),
      mobile.host,
    );
    expect(mobile.json).toHaveBeenCalledWith({
      statusCode: 400,
      code: 'INVALID_INPUT',
      message: 'Invalid input',
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
        code,
        message:
          code === 'UPLOAD_TOO_LARGE' ? 'Upload too large' : 'Invalid request',
        requestId: expect.any(String),
      });
    },
  );
});
