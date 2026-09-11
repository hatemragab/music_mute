import { HttpException } from '@nestjs/common';
import { authError } from '../auth/auth.errors.js';

export async function processingIo<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HttpException) throw error;
    throw authError('SERVICE_UNAVAILABLE');
  }
}
