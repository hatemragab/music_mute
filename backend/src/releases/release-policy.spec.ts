import { describe, expect, it } from 'vitest';
import {
  compareReleaseVersions,
  decideUpdate,
  nextReleaseVersion,
  validateReleaseDraft,
} from './release-policy.js';
import type { UpdatePolicySnapshot } from './release.types.js';

const snapshot: UpdatePolicySnapshot = {
  schemaVersion: 1,
  revision: 2,
  platform: 'android',
  distribution: 'play',
  minimumBuild: 10,
  checkedAt: new Date(0).toISOString(),
  target: {
    id: 'fixture',
    versionName: '1.2',
    buildNumber: 12,
    changelogEn: 'Fixes',
    source: 'google_play',
    storeUrl:
      'https://play.google.com/store/apps/details?id=com.example.fixture',
    artifact: null,
  },
};
describe('release policy', () => {
  it.each([
    ['1.2.0', '1.2.0', 0],
    ['1.10.0', '1.2.9', 1],
    ['2', '1.99.99', 1],
    ['1.2', '1.2.1', -1],
  ] as const)(
    'compares numeric release versions %s and %s',
    (left, right, expected) => {
      expect(Math.sign(compareReleaseVersions(left, right))).toBe(expected);
    },
  );

  it('proposes the next editable patch release', () => {
    expect(nextReleaseVersion('0.1.0')).toBe('0.1.1');
    expect(nextReleaseVersion('2')).toBe('2.0.1');
    expect(nextReleaseVersion('3.4')).toBe('3.4.1');
  });

  it.each(['01.2.0', '1.2.0-beta', '1..2', '1.2.3.4'])(
    'rejects release version %s because it cannot be ordered safely',
    (versionName) => {
      expect(() => compareReleaseVersions(versionName, '1.0.0')).toThrow();
      expect(() =>
        validateReleaseDraft({ ...draft, versionName }, identities),
      ).toThrow();
    },
  );

  it.each([
    [9, 'required'],
    [10, 'optional'],
    [12, 'none'],
    [13, 'none'],
  ] as const)('decides installed build %i', (build, expected) => {
    expect(decideUpdate(build, snapshot)).toBe(expected);
  });
  it('does not invent a requirement with no target', () => {
    expect(
      decideUpdate(1, { ...snapshot, minimumBuild: null, target: null }),
    ).toBe('none');
  });
  it('rejects an unusable or incompatible forced target', () => {
    expect(() => decideUpdate(9, { ...snapshot, minimumBuild: 13 })).toThrow();
    expect(() => decideUpdate(9, { ...snapshot, target: null })).toThrow();
    expect(() => decideUpdate(9, { ...snapshot, platform: 'ios' })).toThrow();
    expect(() => decideUpdate(0, snapshot)).toThrow();
  });
  const draft = {
    platform: 'android',
    source: 'google_play',
    versionName: '1.2',
    buildNumber: 12,
    changelogEn: 'Fixes',
    storeUrl: snapshot.target!.storeUrl,
  };
  const identities = {
    androidPackageId: 'com.example.fixture',
    iosAppStoreId: '123456',
  };
  it('accepts only official store URLs for the configured application', () => {
    expect(() => validateReleaseDraft(draft, identities)).not.toThrow();
    for (const storeUrl of [
      'https://example.com/app',
      'https://play.google.com/store/apps/details?id=com.other.app',
      'https://play.google.com.evil.test/store/apps/details?id=com.example.fixture',
    ]) {
      expect(() =>
        validateReleaseDraft({ ...draft, storeUrl }, identities),
      ).toThrow();
    }
  });
  it('rejects incompatible channels, markup and arbitrary APK URLs', () => {
    expect(() =>
      validateReleaseDraft({ ...draft, platform: 'ios' }, identities),
    ).toThrow();
    expect(() =>
      validateReleaseDraft(
        { ...draft, changelogEn: '<script>x</script>' },
        identities,
      ),
    ).toThrow();
    expect(() =>
      validateReleaseDraft({ ...draft, source: 'direct_apk' }, identities),
    ).toThrow();
    expect(() =>
      validateReleaseDraft(
        { ...draft, source: 'direct_apk', storeUrl: null },
        identities,
      ),
    ).not.toThrow();
  });
});
