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
    const headers = download.mock.calls[0]![4]!.headers;
    expect(headers).not.toHaveProperty('X-Import-Attempt');
    expect(headers).not.toHaveProperty('X-Import-Max-Attempts');
    expect(headers).not.toHaveProperty('X-Import-Acquisition-Started-At');
  });
  it('forwards trusted attempt bounds and the original canonical UTC start', async () => {
    const client = new AudioAcquisitionClient(
      new ConfigService({
        AUDIO_ACQUISITION_API_URL: 'http://music-mute-audio-router:8080/',
        AUDIO_ACQUISITION_API_KEY: 'synthetic-key',
      }),
    );
    const files = new ImportFiles('/tmp/test-imports');
    const download = vi
      .spyOn(files, 'download')
      .mockResolvedValue({ bytes: 12, sha256: 'hash' });
    await client.download(
      'https://youtu.be/abcdefghijk',
      files,
      '/tmp/test-imports/source',
      { maxBytes: 500, maxDuration: 60 },
      new AbortController().signal,
      '00000000-0000-4000-8000-000000000001',
      {
        attempt: 4,
        maxAttempts: 4,
        startedAt: new Date('2026-10-03T03:00:00+03:00'),
      },
    );
    expect(download.mock.calls[0]![4]!.headers).toMatchObject({
      'X-Import-Attempt': '4',
      'X-Import-Max-Attempts': '4',
      'X-Import-Acquisition-Started-At': '2026-10-03T00:00:00.000Z',
    });
  });
  it.each([
    { attempt: 0, maxAttempts: 4 },
    { attempt: 1.5, maxAttempts: 4 },
    { attempt: 5, maxAttempts: 4 },
    { attempt: 1, maxAttempts: 0 },
    { attempt: 1, maxAttempts: 5 },
    { attempt: 1, maxAttempts: Number.NaN },
    { attempt: 1, maxAttempts: 4, startedAt: new Date(Number.NaN) },
  ])(
    'rejects invalid internal context before sending a request: %j',
    async (context) => {
      const client = new AudioAcquisitionClient(
        new ConfigService({
          AUDIO_ACQUISITION_API_URL: 'http://music-mute-audio-router:8080/',
          AUDIO_ACQUISITION_API_KEY: 'synthetic-key',
        }),
      );
      const files = new ImportFiles('/tmp/test-imports');
      const download = vi.spyOn(files, 'download');
      await expect(
        client.download(
          'https://youtu.be/abcdefghijk',
          files,
          '/tmp/test-imports/source',
          { maxBytes: 500, maxDuration: 60 },
          new AbortController().signal,
          undefined,
          { startedAt: new Date('2026-10-03T00:00:00Z'), ...context },
        ),
      ).rejects.toMatchObject({ status: 503 });
      expect(download).not.toHaveBeenCalled();
    },
  );
});
