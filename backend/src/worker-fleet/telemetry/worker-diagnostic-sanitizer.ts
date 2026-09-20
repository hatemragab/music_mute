import { workerError } from '../worker-errors.js';

export function sanitizeWorkerDiagnosticLine(value: string): string {
  if (
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && code !== 9) || code === 127;
    })
  )
    throw workerError('WORKER_INVALID_REQUEST');
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/giu, 'Bearer [REDACTED]')
    .replace(
      /\b(password|secret|token|authorization|api[_-]?key)\s*[:=]\s*\S+/giu,
      '$1=[REDACTED]',
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu, '$1[REDACTED]@')
    .replace(/\/Users\/[^/\s]+/gu, '/Users/[REDACTED]')
    .replace(/C:\\Users\\[^\\\s]+/giu, 'C:\\Users\\[REDACTED]')
    .slice(0, 1000);
}
