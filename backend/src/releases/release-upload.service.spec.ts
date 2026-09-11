import { describe, expect, it } from 'vitest';
import { parseUploadReservation } from './release-upload.service.js';

const valid = {
  bytes: 1024,
  sha256Hex: 'a'.repeat(64),
  expectedRevision: 0,
  operationId: '1c2a047d-e63e-40d5-8a71-22ee3b65d804',
};
describe('release upload reservation input', () => {
  it('accepts exact bounded size and lowercase checksum', () => {
    expect(parseUploadReservation(valid)).toEqual(valid);
  });
  it.each([
    { bytes: 268435457 },
    { bytes: 0 },
    { bytes: 1.5 },
    { bytes: '12' },
    { sha256Hex: 'z'.repeat(64) },
    { expectedRevision: -1 },
    { key: 'app-releases/chosen.apk' },
    { bucket: 'other' },
    { operationId: 'invalid' },
  ])('rejects invalid or caller-selected storage input %j', (patch) => {
    expect(() => parseUploadReservation({ ...valid, ...patch })).toThrow();
  });
});
