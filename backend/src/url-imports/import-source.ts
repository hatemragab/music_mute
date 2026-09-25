import { importError } from './import-errors.js';

export type ImportProvider = string;
export interface ImportSource {
  provider: ImportProvider;
  url: string;
}

export function parseImportSource(value: string): ImportSource {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw importError('IMPORT_INVALID_URL');
  }
  if (
    value.length > 2048 ||
    /[\s\\]/u.test(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32) ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    throw importError('IMPORT_INVALID_URL');
  }
  if (
    [
      'youtube.com',
      'www.youtube.com',
      'm.youtube.com',
      'music.youtube.com',
      'youtu.be',
    ].includes(url.hostname)
  ) {
    if (
      url.searchParams.has('list') ||
      url.searchParams.has('index') ||
      url.pathname === '/playlist'
    )
      throw importError('IMPORT_SINGLE_ITEM_REQUIRED');
    const id =
      url.hostname === 'youtu.be'
        ? url.pathname.slice(1)
        : url.pathname === '/watch'
          ? url.searchParams.get('v')
          : /^\/(?:shorts|embed|live|v|watch)\/([\w-]{11})\/?$/.exec(
              url.pathname,
            )?.[1];
    if (
      !id ||
      !/^[\w-]{11}$/.test(id) ||
      url.searchParams.getAll('v').length > 1
    )
      throw importError('IMPORT_SINGLE_ITEM_REQUIRED');
    return {
      provider: 'youtube',
      url: `https://www.youtube.com/watch?v=${id}`,
    };
  }
  if (
    [
      'soundcloud.com',
      'www.soundcloud.com',
      'm.soundcloud.com',
      'on.soundcloud.com',
    ].includes(url.hostname)
  ) {
    if (url.searchParams.has('in') || url.pathname.split('/').includes('sets'))
      throw importError('IMPORT_SINGLE_ITEM_REQUIRED');
    const valid =
      url.hostname === 'on.soundcloud.com'
        ? /^\/[A-Za-z0-9]+\/?$/.test(url.pathname)
        : /^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/?$/.test(url.pathname);
    if (
      !valid ||
      /^\/(?:discover|charts|search|you|stations)\//.test(url.pathname)
    )
      throw importError('IMPORT_SINGLE_ITEM_REQUIRED');
    url.protocol = 'https:';
    url.hostname =
      url.hostname === 'on.soundcloud.com' ? url.hostname : 'soundcloud.com';
    // Tracking parameters do not identify a different source. Private access is not supported.
    url.search = '';
    return { provider: 'soundcloud', url: url.toString() };
  }
  const host = url.hostname.replace(/^www\./, '');
  if (
    !host.includes('.') ||
    host === 'localhost' ||
    /(?:^|\.)(?:local|localhost|internal)$/.test(host) ||
    host.startsWith('[') ||
    /^[\d.]+$/.test(host)
  )
    throw importError('IMPORT_INVALID_URL');
  // yt-dlp determines site support. Its guarded transport checks DNS and every
  // connection, including redirects; this parser never fetches a user URL.
  return { provider: host, url: url.toString() };
}
