import type { IncomingHttpHeaders } from 'node:http';

// ISO 3166-1 alpha-2 assigned codes. Keep the dashboard's bundled list aligned.
export const COUNTRY_CODES = Object.freeze(
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(
    ' ',
  ),
);
const countries = new Set(COUNTRY_CODES);

export interface CloudflareLocation {
  country: string | null;
  continent: string | null;
  region: string | null;
  regionCode: string | null;
  city: string | null;
  postalCode: string | null;
  metroCode: string | null;
  timezone: string | null;
  latitude: string | null;
  longitude: string | null;
  source: 'cloudflare';
  observedAt: Date;
}

export function visitorCountry(value: unknown): string | null {
  return typeof value === 'string' && countries.has(value) ? value : null;
}

function text(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  // Cloudflare may forward UTF-8 bytes as literal Unicode byte escapes.
  const decoded = value.replace(/(?:\\u00[0-9a-f]{2})+/gi, (bytes) =>
    Buffer.from(
      [...bytes.matchAll(/\\u00([0-9a-f]{2})/gi)].map((match) =>
        Number.parseInt(match[1], 16),
      ),
    ).toString('utf8'),
  );
  if (/\p{Cc}|\p{Cf}|\uFFFD/u.test(decoded)) return null;
  const trimmed = decoded.trim();
  return trimmed.length > 0 && trimmed.length <= maximum ? trimmed : null;
}

function coordinate(value: unknown, bound: number): string | null {
  const parsed = text(value, 24);
  return parsed !== null &&
    /^[+-]?\d{1,3}(?:\.\d{1,12})?$/.test(parsed) &&
    Math.abs(Number(parsed)) <= bound
    ? parsed
    : null;
}

/** Trust depends on the origin being reachable only through Cloudflare. */
export function parseCloudflareLocation(
  headers: IncomingHttpHeaders,
  observedAt = new Date(),
): CloudflareLocation {
  return {
    country: visitorCountry(headers['cf-ipcountry']),
    continent: text(headers['cf-ipcontinent'], 2),
    region: text(headers['cf-region'], 120),
    regionCode: text(headers['cf-region-code'], 8),
    city: text(headers['cf-ipcity'], 120),
    postalCode: text(headers['cf-postal-code'], 16),
    metroCode: text(headers['cf-metro-code'], 8),
    timezone: text(headers['cf-timezone'], 64),
    latitude: coordinate(headers['cf-iplatitude'], 90),
    longitude: coordinate(headers['cf-iplongitude'], 180),
    source: 'cloudflare',
    observedAt,
  };
}

export function sameLocation(
  previous: CloudflareLocation | null | undefined,
  next: CloudflareLocation,
): boolean {
  return (
    previous != null &&
    Object.entries(next).every(
      ([key, value]) =>
        key === 'observedAt' ||
        previous[key as keyof CloudflareLocation] === value,
    )
  );
}
