import { writeSync } from 'node:fs';
import { safeBackendFramePath } from './sentry.js';

/** Only code locations: never error messages, request context or arbitrary paths. */
export function fatalDiagnostic(error: unknown, origin: string) {
  const frames =
    error instanceof Error
      ? (error.stack ?? '')
          .split('\n')
          .slice(1)
          .flatMap((line) => {
            if (!/^\s+at\s/.test(line)) return [];
            const match = line.match(
              /(?:\(|\s)((?:file:\/\/\/|\/|node:)[^\s()]+):(\d+):(\d+)\)?$/,
            );
            if (!match) return [];
            const file = safeBackendFramePath(match[1]);
            if (
              file === '[external]' ||
              !/^(?:node:)?[A-Za-z0-9_./-]+$/.test(file)
            )
              return [];
            return [{ file, line: Number(match[2]), column: Number(match[3]) }];
          })
          .slice(0, 12)
      : [];
  return {
    event: 'backend-fatal',
    origin: origin === 'unhandledRejection' ? origin : 'uncaughtException',
    frames,
  };
}

export function installFatalDiagnostics(): void {
  // Monitoring must not swallow the crash or continue an unsafe process. A
  // synchronous write survives immediate exit; no async network flush needed.
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    try {
      writeSync(2, `${JSON.stringify(fatalDiagnostic(error, origin))}\n`);
    } catch {
      // Preserve Node's original fatal behavior even if stderr is unavailable.
    }
  });
}
