import { createHash } from 'node:crypto';
import { parseImportSource } from '../url-imports/import-source.js';
import type { ObjectIdentity } from '../jobs/job.types.js';

const SHARED_KEY =
  /^shared\/url\/([a-f0-9]{64})\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/(input|output)\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function isSharedMediaKey(key: string): boolean {
  return SHARED_KEY.test(key);
}

export function isSharedMediaObjectKey(
  key: string,
  assetKey: string,
  kind: 'input' | 'output',
): boolean {
  const match = SHARED_KEY.exec(key);
  return match?.[1] === assetKey && match[2] === kind;
}

export function sharedSourceKey(url: string): string {
  const source = parseImportSource(url);
  return createHash('sha256')
    .update(`url-source:v1:${source.provider}:${source.url}`)
    .digest('hex');
}

/** Guest contributions never acquire or overwrite a provider's identity. */
export function communitySourceKey(url: string): string {
  const source = parseImportSource(url);
  if (source.provider !== 'youtube')
    throw new TypeError('Community media requires a YouTube video');
  return createHash('sha256')
    .update(`url-community-source:v1:${source.provider}:${source.url}`)
    .digest('hex');
}

export function sharedResultKey(
  sourceKey: string,
  generation: string,
  recipeDigest: string,
): string {
  return createHash('sha256')
    .update(`url-result:v1:${sourceKey}:${generation}:${recipeDigest}`)
    .digest('hex');
}

/** A producer retry may replace a failed master; its previous rendition cannot follow it. */
export function derivedResultKey(
  sourceKey: string,
  generation: string,
  recipeDigest: string,
  master: ObjectIdentity,
): string {
  return createHash('sha256')
    .update(
      `url-derived-result:v1:${sourceKey}:${generation}:${recipeDigest}:${master.key}:${master.etag}:${master.bytes}:${master.sha256}:${master.contentType}`,
    )
    .digest('hex');
}
