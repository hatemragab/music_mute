import { describe, expect, it } from 'vitest';
import { defaultPolicy, validatePolicy } from '../app-policy/access-policy.js';
import { presentPolicy } from '../app-policy/app-policy.presenter.js';
describe('rich policy compatibility', () => {
  it('accepts optional channel selections without exposing them to legacy clients', () => {
    const legacy = defaultPolicy();
    const rich = {
      ...legacy,
      platforms: {
        ...legacy.platforms,
        android: {
          ...legacy.platforms.android,
          releaseSelection: {
            source: 'direct_apk' as const,
            directReleaseId: null,
            storeReleaseId: null,
          },
        },
      },
    };
    expect(() => validatePolicy(rich)).not.toThrow();
    expect(presentPolicy(rich)).toEqual(presentPolicy(legacy));
  });
  it('rejects malformed selections without relaxing legacy minimum constraints', () => {
    const policy = defaultPolicy();
    expect(() =>
      validatePolicy({
        ...policy,
        platforms: {
          ...policy.platforms,
          android: {
            ...policy.platforms.android,
            releaseSelection: {
              source: 'app_store',
              directReleaseId: null,
              storeReleaseId: null,
            },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      validatePolicy({
        ...policy,
        platforms: {
          ...policy.platforms,
          android: {
            ...policy.platforms.android,
            minimumBuild: 10,
            releaseSelection: {
              source: 'direct_apk',
              directReleaseId: null,
              storeReleaseId: null,
            },
          },
        },
      }),
    ).toThrow();
  });
});
