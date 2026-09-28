import { ConfigService } from '@nestjs/config';
import { AudioAcquisitionClient } from './audio-acquisition-client.js';
import { ImportFiles } from './import-files.js';
describe('provider-neutral audio acquisition client', () => {
  it('sends authenticated bounded requests only to the configured service', async () => {
    const client = new AudioAcquisitionClient(
      new ConfigService({
        AUDIO_ACQUISITION_API_URL: 'http://music-mute-videoscale:8080/',
        AUDIO_ACQUISITION_API_KEY: 'synthetic-key',
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
        '00000000-0000-4000-8000-000000000001',
      ),
    ).toEqual({ bytes: 12, sha256: 'hash' });
    expect(download).toHaveBeenCalledWith(
      'http://music-mute-videoscale:8080/audio-imports',
      '/tmp/test-imports/source',
      500,
      signal,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer synthetic-key',
          'X-Import-Request-ID': '00000000-0000-4000-8000-000000000001',
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
