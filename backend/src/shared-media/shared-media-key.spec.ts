import { describe, expect, it } from 'vitest';
import {
  SharedMediaSourceSchema,
  SharedMediaResultSchema,
  SharedMediaArtifactSchema,
} from './shared-media.schema.js';
import {
  isSharedMediaKey,
  isSharedMediaObjectKey,
  sharedSourceKey,
  sharedResultKey,
} from './shared-media-key.js';

describe('shared media identity', () => {
  it('unifies accepted YouTube links without treating ID case as equivalent', () => {
    const key = sharedSourceKey('https://youtube.com/watch?v=BaW_jenozKc&t=90');
    for (const url of [
      'https://youtu.be/BaW_jenozKc?si=tracking',
      'https://m.youtube.com/shorts/BaW_jenozKc',
      'https://www.youtube.com/embed/BaW_jenozKc',
    ])
      expect(sharedSourceKey(url)).toBe(key);
    expect(sharedSourceKey('https://youtu.be/baw_jenozkc')).not.toBe(key);
  });

  it('normalizes supported site forms and keeps distinct items distinct', () => {
    expect(
      sharedSourceKey(
        'http://www.soundcloud.com/artist/track?utm_source=share',
      ),
    ).toBe(sharedSourceKey('https://soundcloud.com/artist/track'));
    expect(sharedSourceKey('https://soundcloud.com/artist/other')).not.toBe(
      sharedSourceKey('https://soundcloud.com/artist/track'),
    );
    expect(() =>
      sharedSourceKey('https://youtube.com/playlist?list=abc'),
    ).toThrow();
    expect(() =>
      sharedSourceKey('https://user:password@example.com/item'),
    ).toThrow();
  });

  it('separates result recipes and source generations', () => {
    const source = 'a'.repeat(64);
    const recipe = 'b'.repeat(64);
    const key = sharedResultKey(source, 'generation-1', recipe);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(sharedResultKey(source, 'generation-2', recipe)).not.toBe(key);
    expect(sharedResultKey(source, 'generation-1', 'c'.repeat(64))).not.toBe(
      key,
    );
  });

  it('recognizes only exact shared asset paths and their role', () => {
    const asset = 'a'.repeat(64);
    const key = `shared/url/${asset}/11111111-1111-4111-8111-111111111111/input/source.opus`;
    expect(isSharedMediaKey(key)).toBe(true);
    expect(isSharedMediaObjectKey(key, asset, 'input')).toBe(true);
    expect(isSharedMediaObjectKey(key, 'b'.repeat(64), 'input')).toBe(false);
    expect(isSharedMediaObjectKey(key, asset, 'output')).toBe(false);
    for (const invalid of [
      'users/owner/jobs/job/input/source.opus',
      `${key}/extra`,
      key.replace('/input/', '/../'),
      key.replace('4111', '3111'),
    ])
      expect(isSharedMediaKey(invalid)).toBe(false);
  });

  it('declares no automatic expiry for shared originals or vocals', () => {
    for (const schema of [
      SharedMediaSourceSchema,
      SharedMediaResultSchema,
      SharedMediaArtifactSchema,
    ])
      expect(
        schema
          .indexes()
          .some(([, options]) => options.expireAfterSeconds !== undefined),
      ).toBe(false);
  });
});
