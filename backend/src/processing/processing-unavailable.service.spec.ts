import { describe, expect, it } from 'vitest';
import { ProcessingUnavailableService } from './processing-unavailable.service.js';

describe('ProcessingUnavailableService', () => {
  it('rejects new processing work with the stable redesign boundary', () => {
    const service = new ProcessingUnavailableService();

    try {
      service.reject();
      throw new Error('expected reject() to throw');
    } catch (error) {
      expect(error).toMatchObject({ status: 503 });
      expect((error as { getResponse(): unknown }).getResponse()).toEqual({
        statusCode: 503,
        code: 'PROCESSING_UNAVAILABLE',
        message: 'New audio processing work is unavailable',
      });
    }
  });
});
