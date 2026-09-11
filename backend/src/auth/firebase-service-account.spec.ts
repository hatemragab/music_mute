import { decodeFirebaseServiceAccount } from './firebase-service-account.js';

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

describe('decodeFirebaseServiceAccount', () => {
  it('converts a CapRover base64 secret into Firebase Admin credentials', () => {
    const encoded = encode({
      project_id: 'musicmute-production',
      client_email: 'firebase-admin@example.iam.gserviceaccount.com',
      private_key: 'fixture-private-key',
    });

    expect(
      decodeFirebaseServiceAccount(encoded, 'musicmute-production'),
    ).toEqual({
      projectId: 'musicmute-production',
      clientEmail: 'firebase-admin@example.iam.gserviceaccount.com',
      privateKey: 'fixture-private-key',
    });
  });

  it('rejects credentials for a different Firebase project', () => {
    const encoded = encode({
      project_id: 'wrong-project',
      client_email: 'firebase-admin@example.iam.gserviceaccount.com',
      private_key: 'private-secret',
    });

    expect(() =>
      decodeFirebaseServiceAccount(encoded, 'musicmute-production'),
    ).toThrow(
      'FIREBASE_SERVICE_ACCOUNT_BASE64 project does not match FIREBASE_PROJECT_ID',
    );
  });

  it('rejects malformed credentials without exposing their contents', () => {
    const malformed = Buffer.from('private-secret', 'utf8').toString('base64');

    expect(() =>
      decodeFirebaseServiceAccount(malformed, 'musicmute-production'),
    ).toThrow('Invalid FIREBASE_SERVICE_ACCOUNT_BASE64');
  });
});
