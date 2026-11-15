import {
  COUNTRY_CODES,
  parseCloudflareLocation,
  sameLocation,
  visitorCountry,
} from './cloudflare-location.js';

describe('Cloudflare visitor location', () => {
  it('accepts only assigned uppercase alpha-2 codes', () => {
    expect(COUNTRY_CODES).toHaveLength(249);
    expect(new Set(COUNTRY_CODES).size).toBe(249);
    expect(visitorCountry('EG')).toBe('EG');
    for (const value of [
      'XX',
      'T1',
      'ZZ',
      'eg',
      '',
      ' EG',
      undefined,
      ['EG'],
    ]) {
      expect(visitorCountry(value)).toBeNull();
    }
  });

  it('preserves UTF-8, decodes escaped bytes, bounds values and drops control characters', () => {
    const location = parseCloudflareLocation({
      'cf-ipcountry': 'EG',
      'cf-ipcity': '\\u00d9\\u0085\\u00d8\\u00b5\\u00d8\\u00b1',
      'cf-region': 'القاهرة',
      'cf-region-code': 'too-long-code',
      'cf-timezone': 'Africa/Cairo',
      'cf-postal-code': '123\n456',
      'cf-iplatitude': '30.0444',
      'cf-iplongitude': '-180.0',
    });
    expect(location).toMatchObject({
      country: 'EG',
      city: 'مصر',
      region: 'القاهرة',
      regionCode: null,
      postalCode: null,
      latitude: '30.0444',
      longitude: '-180.0',
      source: 'cloudflare',
    });
    expect(
      parseCloudflareLocation({
        'cf-ipcity': 'a'.repeat(121),
        'cf-iplatitude': '90.1',
        'cf-iplongitude': '1e2',
      }),
    ).toMatchObject({ city: null, latitude: null, longitude: null });
    expect(
      parseCloudflareLocation({ 'cf-ipcity': '🎵'.repeat(61) }).city,
    ).toBeNull();
  });

  it('represents unknown current observations and compares without the timestamp', () => {
    const previous = parseCloudflareLocation({}, new Date(0));
    expect(previous.country).toBeNull();
    expect(
      sameLocation(previous, parseCloudflareLocation({}, new Date(10))),
    ).toBe(true);
    expect(
      sameLocation(previous, parseCloudflareLocation({ 'cf-ipcountry': 'US' })),
    ).toBe(false);
    expect(sameLocation(null, previous)).toBe(false);
  });
});
