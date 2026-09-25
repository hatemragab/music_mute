import { ConfigService } from '@nestjs/config';
import { YtdlpClient } from './ytdlp-client.js';
import { ImportFiles } from './import-files.js';
describe('yt-dlp client', () => {
  it('sends authenticated bounded requests only to the configured service', async () => {
    const client = new YtdlpClient(
      new ConfigService({
        YTDLP_API_URL: 'http://music-mute-ytdlp-test:8080/',
        YTDLP_API_KEY: 'synthetic-key',
      }),
    );
    const files = new ImportFiles('/tmp/test-imports');
    const download = vi
      .spyOn(files, 'download')
      .mockResolvedValue({ bytes: 12, sha256: 'hash' });
    const signal = new AbortController().signal;
    expect(
      await client.download(
        'https://facebook.com/share/v/example/',
        files,
        '/tmp/test-imports/source',
        { maxBytes: 500, maxDuration: 60 },
        signal,
      ),
    ).toEqual({ bytes: 12, sha256: 'hash' });
    expect(download).toHaveBeenCalledWith(
      'http://music-mute-ytdlp-test:8080/audio-imports',
      '/tmp/test-imports/source',
      500,
      signal,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer synthetic-key',
        }),
        body: JSON.stringify({
          url: 'https://facebook.com/share/v/example/',
          max_bytes: 500,
          max_duration_seconds: 60,
        }),
      }),
    );
  });
});
