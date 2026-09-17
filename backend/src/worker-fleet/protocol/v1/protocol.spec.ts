import { describe, expect, it } from 'vitest';
import {
  parseWorkerProtocolEnvelope,
  WorkerProtocolValidationError,
} from './protocol.js';

const validEnvelope = () => ({
  protocolVersion: 1,
  operation: 'session.open',
  requestId: '8dbe6c44-45ee-4dd1-9a9f-f4cc87fd9cb0',
  sentAt: '2026-09-17T12:00:00.000Z',
  payload: { machineId: '0c347b75-afb5-4d01-aeab-00af9c927ceb' },
});

describe('worker protocol v1 envelope', () => {
  it('accepts the exact bounded v1 envelope', () => {
    expect(parseWorkerProtocolEnvelope(validEnvelope())).toEqual(
      validEnvelope(),
    );
  });

  it('rejects unknown envelope fields and unsupported versions', () => {
    expect(() =>
      parseWorkerProtocolEnvelope({ ...validEnvelope(), secret: 'no' }),
    ).toThrow(WorkerProtocolValidationError);
    try {
      parseWorkerProtocolEnvelope({ ...validEnvelope(), protocolVersion: 2 });
    } catch (error) {
      expect(error).toMatchObject({ code: 'PROTOCOL_VERSION_UNSUPPORTED' });
    }
    expect(() =>
      parseWorkerProtocolEnvelope({
        ...validEnvelope(),
        operation: 'shell.execute',
      }),
    ).toThrow('Worker protocol operation is invalid');
  });

  it('rejects oversized and dangerous payloads', () => {
    expect(() =>
      parseWorkerProtocolEnvelope({
        ...validEnvelope(),
        payload: { value: 'x'.repeat(4097) },
      }),
    ).toThrow('Protocol string is too long');
    const payload = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(payload, '__proto__', {
      value: 'blocked',
      enumerable: true,
    });
    expect(() =>
      parseWorkerProtocolEnvelope({ ...validEnvelope(), payload }),
    ).toThrow('Protocol payload contains an invalid key');
  });
});
