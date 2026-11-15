import { ConsoleLogger } from '@nestjs/common';
import { localDiagnostics, type DiagnosticEvent } from './local-diagnostics.js';

class LocalApiLogger extends ConsoleLogger {
  constructor() {
    super({ logLevels: ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] });
  }

  override log(message: unknown, ...params: unknown[]) {
    this.record('info', message, params);
  }
  override error(message: unknown, ...params: unknown[]) {
    this.record('error', message, params);
  }
  override warn(message: unknown, ...params: unknown[]) {
    this.record('warn', message, params);
  }
  override debug(message: unknown, ...params: unknown[]) {
    this.record('debug', message, params);
  }
  override verbose(message: unknown, ...params: unknown[]) {
    this.record('debug', message, params);
  }
  override fatal(message: unknown, ...params: unknown[]) {
    this.record('error', message, params);
  }

  private record(
    level: DiagnosticEvent['level'],
    message: unknown,
    params: unknown[],
  ) {
    const candidate =
      message && typeof message === 'object'
        ? (message as Record<string, unknown>)
        : {};
    const context = params.at(-1);
    const descriptor = Object.getOwnPropertyDescriptor(candidate, 'event');
    const eventName =
      descriptor && 'value' in descriptor
        ? (descriptor.value as unknown)
        : undefined;
    localDiagnostics.event({
      level,
      category: 'service',
      name: typeof eventName === 'string' ? eventName : 'nest.log',
      summary: 'Application service log',
      data: {
        context:
          typeof context === 'string' &&
          /^[A-Za-z][A-Za-z0-9_.]{0,95}$/.test(context)
            ? context
            : undefined,
        message: localDiagnostics.snapshot(message),
      },
    });
  }
}

/** Operational failures remain JSON; routine metrics and retry chatter stay muted. */
export function createApiLogger(): ConsoleLogger {
  if (localDiagnostics.isEnabled) return new LocalApiLogger();
  return new ConsoleLogger({ json: true, logLevels: ['error'] });
}
