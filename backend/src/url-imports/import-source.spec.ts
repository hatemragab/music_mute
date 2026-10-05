import { parseImportSource } from './import-source.js';
describe('import source admission', () => {
  it('preserves YouTube canonical identity', () => {
    expect(parseImportSource('https://youtu.be/abcdefghijk?t=20')).toEqual({
      provider: 'youtube',
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
    });
  });
  it.each([
    'https://www.youtube.com/watch?v=e6WT8RwRwt4&list=RDe6WT8RwRwt4&start_radio=1',
    'https://youtube.com/watch?v=e6WT8RwRwt4&list=PL1&index=2&t=20',
    'https://youtube.com/watch?v=e6WT8RwRwt4&%6cist=PL1',
    'https://music.youtube.com/watch?v=e6WT8RwRwt4&list=PL1',
    'https://youtu.be/e6WT8RwRwt4?list=PL1&index=2',
    'https://www.youtu.be/e6WT8RwRwt4/?list=PL1&index=2',
    'https://youtube.com/watch/?v=e6WT8RwRwt4&list=PL1',
    'https://youtube.com/shorts/e6WT8RwRwt4?list=PL1',
    'https://youtube.com/embed/e6WT8RwRwt4?playlist=abcdefghijk',
    'https://youtube.com/live/e6WT8RwRwt4?v=e6WT8RwRwt4&list=PL1',
  ])('imports only the selected YouTube video: %s', (url) => {
    expect(parseImportSource(url)).toEqual({
      provider: 'youtube',
      url: 'https://www.youtube.com/watch?v=e6WT8RwRwt4',
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
    'https://youtube.com/playlist?list=PL1',
    'https://youtube.com/playlist?v=abcdefghijk&list=PL1',
    'https://youtube.com/watch?list=PL1&index=2',
    'https://youtube.com/watch?v=short&list=PL1',
    'https://youtube.com/watch?v=abcdefghijk&v=e6WT8RwRwt4&list=PL1',
    'https://youtube.com/watch?v=abcdefghijk&%76=abcdefghijk&list=PL1',
    'https://youtu.be/abcdefghijk?v=e6WT8RwRwt4&list=PL1',
    'https://youtube.com/shorts/abcdefghijk?v=e6WT8RwRwt4&list=PL1',
    'https://youtu.be/abcdefghijk/extra?list=PL1',
    'https://www.youtu.be//abcdefghijk?list=PL1',
    'https://youtube.com/@channel',
    'https://soundcloud.com/artist/sets/album',
    'https://soundcloud.com/artist/track?in=artist/sets/album',
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
