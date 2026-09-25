import {
  Injectable,
  type ArgumentMetadata,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
  type PipeTransform,
} from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import { authError } from '../auth/auth.errors.js';

const snakeCaseKey = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

function toCamelCase(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_match, letter: string) =>
    letter.toUpperCase(),
  );
}

function toSnakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requestValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(requestValue);
  if (!isPlainObject(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (!snakeCaseKey.test(key)) throw authError('INVALID_INPUT');
      return [toCamelCase(key), requestValue(item)];
    }),
  );
}

function responseValue(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value))
    return value.map((item) => responseValue(item, parentKey));
  if (!isPlainObject(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      toSnakeCase(key),
      // These objects have their own external naming contracts: S3 request
      // headers and the exact bytes covered by the worker release signature.
      key === 'headers' || (parentKey === 'signed' && key === 'metadata')
        ? item
        : responseValue(item, key),
    ]),
  );
}

/** Convert only public JSON and query keys; internal DTOs remain camelCase. */
@Injectable()
export class SnakeCaseRequestPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'body' && metadata.type !== 'query') return value;
    return requestValue(value);
  }
}

/** Convert successful JSON responses before Nest sends them to Express. */
@Injectable()
export class SnakeCaseResponseInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle().pipe(map((value: unknown) => responseValue(value)));
  }
}
