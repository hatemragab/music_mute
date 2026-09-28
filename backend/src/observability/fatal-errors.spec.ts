import { fatalDiagnostic } from './fatal-errors.js';

describe('fatal process diagnostics', () => {
  it('keeps bounded code frames, not secrets or paths outside code', () => {
    const error = new Error('Bearer secret https://private.invalid');
    error.stack = [
      error.message,
      '    at doWork (/app/dist/url-imports/import-processor.js:12:3)',
      '    at private (/Users/private/media.wav:1:2)',
      '    at fetch (https://secret.invalid/?token=secret:1:2)',
      '    at process (node:internal/process/task_queues:1:2)',
    ].join('\n');
    const result = fatalDiagnostic(error, 'unhandledRejection');
    expect(result).toEqual({
      event: 'backend-fatal',
      origin: 'unhandledRejection',
      frames: [
        { file: 'dist/url-imports/import-processor.js', line: 12, column: 3 },
        { file: 'node:internal/process/task_queues', line: 1, column: 2 },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|private|Bearer/);
  });

  it('handles non-Error throws without serializing the thrown object', () => {
    expect(fatalDiagnostic({ token: 'secret' }, 'untrusted')).toEqual({
      event: 'backend-fatal',
      origin: 'uncaughtException',
      frames: [],
    });
  });
});
