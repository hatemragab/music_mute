import { createApiLogger } from './api-logger.js';
import { safeProcessingFailure } from '../processing/processing-diagnostics.js';

afterEach(() => vi.restoreAllMocks());

describe('API error-only logging', () => {
  it('does not emit routine realtime metrics, completed work or retry warnings', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const logger = createApiLogger();
    logger.log({ event: 'realtime_socket_metrics', active_clients: 2 });
    logger.log({ event: 'processing-transaction', result: 'SUCCEEDED' });
    logger.warn({ event: 'processing-transaction', result: 'CALLBACK_FAILED' });
    logger.debug('Routine connection diagnostic');
    logger.verbose('Healthy application');
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('emits sanitized failure context as JSON errors and keeps fatal diagnostics enabled', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const logger = createApiLogger();
    const failure = Object.assign(
      new Error('private signed URL and password'),
      {
        name: 'MongoOperationTimeoutError',
        cause: Object.assign(new Error('private database URI'), {
          name: 'MongoServerError',
          code: 112,
          errorLabels: ['TransientTransactionError'],
        }),
      },
    );
    const diagnostic = {
      event: 'import-reconciliation',
      result: 'TERMINAL_FAILURE',
      acquisition_id: 'ca913ccb-9ee0-4c65-9df0-d4a5fced9b24',
      failure: safeProcessingFailure(failure),
    };
    logger.error(diagnostic, 'ImportProcessor');
    expect(stderr).toHaveBeenCalledOnce();
    expect(stdout).not.toHaveBeenCalled();
    const encoded = String(stderr.mock.calls[0][0]);
    const entry = JSON.parse(encoded) as {
      level: string;
      context: string;
      message: unknown;
    };
    expect(entry.level).toBe('error');
    expect(entry.context).toBe('ImportProcessor');
    expect(entry.message).toEqual(diagnostic);
    expect(encoded).not.toMatch(/private|password|URI|stack/);
    expect(logger.isLevelEnabled('fatal')).toBe(true);
  });
});
