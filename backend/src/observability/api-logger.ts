import { ConsoleLogger } from '@nestjs/common';

/** Operational failures remain JSON; routine metrics and retry chatter stay muted. */
export function createApiLogger(): ConsoleLogger {
  return new ConsoleLogger({ json: true, logLevels: ['error'] });
}
