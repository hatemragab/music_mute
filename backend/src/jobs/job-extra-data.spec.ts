import { describe, expect, it } from 'vitest';
import {
  decodeExtraData,
  normalizeExtraData,
  normalizeThumbnailUrl,
} from './job-extra-data.js';
import { JobSchema } from './job.schema.js';
import { SharedMediaSourceSchema } from '../shared-media/shared-media.schema.js';
import { model } from 'mongoose';

describe('included acquisition metadata', () => {
  it('defaults missing, malformed and unknown versions to null', () => {
    for (const value of [
      null,
      [],
      {},
      { schema_version: 2 },
      { schema_version: 1 },
    ])
      expect(normalizeExtraData(value)).toBeNull();
    for (const value of [
      null,
      'bad!',
      'x'.repeat(4097),
      Buffer.from('{').toString('base64'),
      '/w==',
    ])
      expect(decodeExtraData(value)).toBeNull();
  });
  it('bounds Unicode titles by code points and removes invisible controls', () => {
    const value = normalizeExtraData({
      schema_version: 1,
      title: ' \u202e' + '🎵'.repeat(201),
    });
    expect(value?.title).toBe('🎵'.repeat(200));
    expect(
      normalizeExtraData({ schema_version: 1, title: ' \r\n ' }),
    ).toBeNull();
  });
  it('allowlists fields, strips controls and drops URLs, credentials and invalid numbers', () => {
    expect(
      normalizeExtraData({
        schema_version: 1,
        provider: 'videoscale',
        title: ' A\nB ',
        audio_codec: 'aac',
        audio_channels: 2,
        bitrate_kbps: NaN,
        file_bytes: -1,
        description: 'https://storage.test?Signature=secret',
        raw: { Authorization: 'secret' },
        download_url: 'https://secret.test',
        __proto__: { polluted: true },
      }),
    ).toEqual({
      schema_version: 1,
      provider: 'videoscale',
      title: 'AB',
      audio_codec: 'aac',
      audio_channels: 2,
    });
  });
  it('decodes bounded headers and sanitizes MongoDB writes', () => {
    const value = {
      schema_version: 1,
      provider: 'videoscale',
      format_id: '140',
      raw: 'secret',
    };
    const safe = {
      schema_version: 1,
      provider: 'videoscale',
      format_id: '140',
    };
    expect(
      decodeExtraData(Buffer.from(JSON.stringify(value)).toString('base64')),
    ).toEqual(safe);
    const Job = model('ExtraDataFixture', JobSchema);
    expect(new Job().extra_data).toBeNull();
    expect(new Job({ extra_data: value }).extra_data).toEqual(safe);
  });
  it('retains the exact original thumbnail in headers, shared sources and jobs', () => {
    const thumbnail =
      'https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg?sqp=fixture%3D&rs=fixture';
    const metadata = {
      schema_version: 1,
      title: 'Synthetic video',
      thumbnail_url: thumbnail,
    };
    expect(
      decodeExtraData(Buffer.from(JSON.stringify(metadata)).toString('base64')),
    ).toEqual(metadata);
    const Job = model('ThumbnailExtraDataFixture', JobSchema);
    const Source = model(
      'ThumbnailSharedSourceFixture',
      SharedMediaSourceSchema,
    );
    expect(new Job({ extra_data: metadata }).extra_data).toEqual(metadata);
    expect(new Source({ extraData: metadata }).extraData).toEqual(metadata);
    expect(normalizeExtraData(metadata)).toEqual(metadata);
  });
  it('allows only bounded original public YouTube image URLs', () => {
    const thumbnail = 'https://i.ytimg.com/vi/fixture_123/hqdefault.jpg';
    for (const value of [
      thumbnail,
      thumbnail.replace('/vi/', '/vi_webp/').replace('.jpg', '.webp'),
    ])
      expect(normalizeThumbnailUrl(value)).toBe(value);
    for (const value of [
      null,
      undefined,
      '',
      1,
      [],
      thumbnail.replace('https:', 'http:'),
      thumbnail.replace('i.ytimg.com', 'i.ytimg.com.evil.invalid'),
      thumbnail.replace('i.ytimg.com', 'user:secret@i.ytimg.com'),
      thumbnail.replace('i.ytimg.com', 'i.ytimg.com:443'),
      thumbnail.replace('/vi/', '/vi/../vi/'),
      thumbnail + '#fragment',
      ' ' + thumbnail,
      thumbnail + '\n',
      thumbnail + '?token=secret',
      thumbnail + '?sqp=one&sqp=two',
      thumbnail + '?sqp=one&',
      thumbnail + '?sqp=',
      thumbnail + '?sqp=one+two',
      thumbnail + '?sqp=one&rs=two&third=three',
      thumbnail + '?rs=' + 'x'.repeat(1025),
      thumbnail.replace('.jpg', '.svg'),
    ]) {
      expect(normalizeThumbnailUrl(value)).toBeNull();
      expect(
        normalizeExtraData({
          schema_version: 1,
          title: 'Synthetic video',
          thumbnail_url: value,
        }),
      ).toEqual({
        schema_version: 1,
        title: 'Synthetic video',
      });
    }
  });
});
