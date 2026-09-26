import { Logger } from '@nestjs/common';

const logger = new Logger('WorkerTransferTiming');
type TransferOperation =
  | 'output_grant'
  | 'output_grant_signing'
  | 'output_grant_transaction'
  | 'completion'
  | 'completion_storage_verification'
  | 'completion_transaction';

/** Numeric server timings only: never log grants, object keys or provider errors. */
export async function measureTransferOperation<T>(
  operation: TransferOperation,
  attemptId: string,
  run: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  let success = false;
  try {
    const result = await run();
    success = true;
    return result;
  } finally {
    logger.debug({
      event: 'worker_transfer_timing',
      operation,
      ...(/^[a-f0-9-]{36}$/i.test(attemptId) ? { attempt_id: attemptId } : {}),
      duration_ms: Math.max(0, Math.round(performance.now() - started)),
      success,
    });
  }
}
