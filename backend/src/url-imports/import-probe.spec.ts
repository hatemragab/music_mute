import { inspectProbe } from './import-probe.js';

describe('measured audio validation', () => {
  const probe = {
    format: { format_name: 'matroska,webm', duration: '12.5' },
    streams: [{ codec_type: 'audio', codec_name: 'opus' }],
  };
  it('uses measured duration and native container instead of the upstream filename', () =>
    expect(inspectProbe(probe, 20)).toEqual({
      durationSeconds: 12.5,
      extension: 'webm',
      contentType: 'audio/webm',
    }));
  it('rejects over-limit duration', () =>
    expect(() => inspectProbe(probe, 12)).toThrow('duration'));
  it.each([
    { streams: [{ codec_type: 'video', codec_name: 'h264' }] },
    {
      streams: [...probe.streams, { codec_type: 'video', codec_name: 'h264' }],
    },
    { streams: [] },
    { format: { duration: 'NaN' } },
    { format: { duration: '-1' } },
    { format: { duration: '4', format_name: 'hls' } },
  ])('rejects invalid tracks/container/duration %j', (change) =>
    expect(() => inspectProbe({ ...probe, ...change }, 1200)).toThrow(),
  );
});
