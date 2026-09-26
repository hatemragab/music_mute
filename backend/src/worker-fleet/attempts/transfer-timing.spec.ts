import { Logger } from '@nestjs/common';
import { measureTransferOperation } from './transfer-timing.js';

const attemptId = 'a180b65e-c118-400c-aba2-3928bf461f44';
afterEach(() => vi.restoreAllMocks());

it('records monotonic timing without changing the operation result', async () => {
  const log = vi
    .spyOn(Logger.prototype, 'debug')
    .mockImplementation(() => undefined);
  vi.spyOn(performance, 'now')
    .mockReturnValueOnce(100)
    .mockReturnValueOnce(142.4);
  await expect(
    measureTransferOperation(
      'completion_transaction',
      attemptId,
      async () => 'result',
    ),
  ).resolves.toBe('result');
  expect(log).toHaveBeenCalledWith({
    event: 'worker_transfer_timing',
    operation: 'completion_transaction',
    attempt_id: attemptId,
    duration_ms: 42,
    success: true,
  });
});

it('preserves failures without logging their sensitive details or invalid identifiers', async () => {
  const log = vi
    .spyOn(Logger.prototype, 'debug')
    .mockImplementation(() => undefined);
  const error = new Error('https://secret.invalid/?signature=credential');
  await expect(
    measureTransferOperation(
      'completion_storage_verification',
      'untrusted identifier',
      async () => {
        throw error;
      },
    ),
  ).rejects.toBe(error);
  expect(log).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  expect(JSON.stringify(log.mock.calls)).not.toMatch(
    /credential|secret|untrusted/,
  );
});
