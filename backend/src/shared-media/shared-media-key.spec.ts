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
  communitySourceKey,
  derivedResultKey,
} from './shared-media-key.js';

describe('shared media identity', () => {
  it('salts guest sources apart from trusted sources and binds derivatives to immutable master bytes', () => {
    const first =
      'https://www.youtube.com/watch?v=bZxrIoCPsOc&list=RDbZxrIoCPsOc&start_radio=1';
    const second = 'https://youtu.be/bZxrIoCPsOc?si=RLbbOevlM4lBmXHi';
    expect(communitySourceKey(first)).toBe(communitySourceKey(second));
    expect(communitySourceKey(first)).not.toBe(sharedSourceKey(first));
    expect(() =>
      communitySourceKey('https://soundcloud.com/artist/track'),
    ).toThrow();
    const master = {
      key: 'shared/full.mp3',
      etag: '"full"',
      bytes: 100,
      sha256: Buffer.alloc(32, 1).toString('base64'),
      contentType: 'audio/mpeg',
    };
    const key = derivedResultKey(
      'a'.repeat(64),
      'generation',
      'b'.repeat(64),
      master,
    );
    for (const change of [
      { etag: '"new"' },
      { key: 'shared/new.mp3' },
      { sha256: Buffer.alloc(32, 2).toString('base64') },
    ])
      expect(
        derivedResultKey('a'.repeat(64), 'generation', 'b'.repeat(64), {
          ...master,
          ...change,
        }),
      ).not.toBe(key);
  });
  it('unifies accepted YouTube links without treating ID case as equivalent', () => {
    const key = sharedSourceKey('https://youtube.com/watch?v=BaW_jenozKc&t=90');
    for (const url of [
      'https://youtu.be/BaW_jenozKc?si=tracking',
      'https://m.youtube.com/shorts/BaW_jenozKc',
      'https://www.youtube.com/embed/BaW_jenozKc',
      'https://youtube.com/watch?v=BaW_jenozKc&list=PL123&index=2',
      'https://music.youtube.com/watch?v=BaW_jenozKc&list=RDBaW_jenozKc&start_radio=1',
      'https://youtu.be/BaW_jenozKc?list=PL123',
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
