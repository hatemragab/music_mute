import { Injectable, type PipeTransform } from '@nestjs/common';
import { authError } from '../auth.errors.js';

@Injectable()
export class EmptyBodyPipe implements PipeTransform<unknown, void> {
  transform(value: unknown): void {
    if (value === undefined) return;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== 0
    )
      throw authError('INVALID_INPUT');
  }
}
