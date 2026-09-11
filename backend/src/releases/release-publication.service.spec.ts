import { describe, expect, it } from 'vitest';
import {
  validateSelection,
  validatePolicyTransition,
} from './release-publication.service.js';
import { defaultPolicy } from '../app-policy/access-policy.js';
const empty = {
  android: {
    minimumBuild: null,
    directReleaseId: null,
    storeReleaseId: null,
    source: 'direct_apk',
  },
  ios: { minimumBuild: null, storeReleaseId: null },
};
describe('complete update selection validation', () => {
  it('retains an activated Play target while Android minimum remains forced', () => {
    const current = defaultPolicy();
    current.platforms.android.releaseSelection = {
      source: 'direct_apk',
      directReleaseId: 'a'.repeat(24),
      storeReleaseId: 'b'.repeat(24),
    };
    current.platforms.android.minimumBuild = 10;
    const next = validateSelection({
      ...empty,
      android: {
        ...empty.android,
        minimumBuild: 10,
        directReleaseId: 'a'.repeat(24),
      },
    });
    expect(() => validatePolicyTransition(current, next, false)).toThrow();
    expect(() =>
      validatePolicyTransition(
        current,
        { ...next, android: { ...next.android, minimumBuild: null } },
        false,
      ),
    ).not.toThrow();
  });
  it('requires explicit withdrawal for lowering either platform minimum', () => {
    const current = defaultPolicy();
    current.platforms.ios.minimumBuild = 10;
    const next = validateSelection(empty);
    expect(() => validatePolicyTransition(current, next, true)).toThrow();
    expect(() => validatePolicyTransition(current, next, false)).not.toThrow();
  });
  it('accepts explicitly empty targets and minimums', () => {
    expect(validateSelection(empty)).toEqual(empty);
  });
  it('rejects omitted channels, unknown fields, invalid builds and foreign IDs', () => {
    for (const body of [
      { android: empty.android },
      { ...empty, requireVerifiedEmail: false },
      { ...empty, android: { ...empty.android, minimumBuild: 0 } },
      { ...empty, ios: { ...empty.ios, storeReleaseId: 'bad' } },
      { ...empty, android: { ...empty.android, source: 'app_store' } },
    ]) {
      expect(() => validateSelection(body)).toThrow();
    }
  });
});
