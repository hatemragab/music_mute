import { parseImportSource } from './import-source.js';
describe('import source admission', () => {
  it('preserves YouTube canonical identity', () => {
    expect(parseImportSource('https://youtu.be/abcdefghijk?t=20')).toEqual({
      provider: 'youtube',
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
    });
  });
  it.each([
    'https://www.facebook.com/share/v/19duj8sfLg/',
    'https://www.instagram.com/reel/example/',
    'https://vimeo.com/12345',
    'https://new-supported-site.example/audio?id=123',
  ])('delegates site support: %s', (url) => {
    expect(parseImportSource(url).url).toBe(url);
  });
  it.each([
    'https://youtube.com/watch?v=abcdefghijk&list=PL1',
    'https://youtube.com/@channel',
    'https://soundcloud.com/artist/sets/album',
    'https://user:password@facebook.com/video',
    'http://127.0.0.1/audio',
    'http://169.254.169.254/audio',
    'http://[::1]/audio',
    'http://localhost/audio',
    'http://api/audio',
    'http://metadata.google.internal/audio',
    'file:///tmp/audio',
    'https://facebook.com:9000/audio',
    'https://facebook.com/has space',
  ])('rejects invalid input: %s', (url) => {
    expect(() => parseImportSource(url)).toThrow();
  });
});
