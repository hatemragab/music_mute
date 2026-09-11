import {
  decodeHistoryCursor,
  encodeHistoryCursor,
} from './jobs-query.service.js';

describe('history cursor', () => {
  it('round trips stable date and object id', () => {
    const position = {
      createdAt: new Date('2026-09-09T00:00:00.000Z'),
      id: '0123456789abcdef01234567',
    };
    expect(decodeHistoryCursor(encodeHistoryCursor(position))).toEqual(
      position,
    );
  });
  it.each([
    '!',
    'e30',
    Buffer.from(JSON.stringify({ createdAt: 'bad', id: 'x' })).toString(
      'base64url',
    ),
    'a'.repeat(1025),
  ])('rejects invalid cursor %s', (cursor) => {
    expect(() => decodeHistoryCursor(cursor)).toThrow();
  });
});
