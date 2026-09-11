import 'reflect-metadata';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

test('production Firebase verifier rejects forged signatures and wrong claims using local public-key fixtures', async () => {
  // This suite uses the SDK's production signature path, never emulator verification.
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const { FirebaseIdentityService } =
    await import('../dist/auth/firebase-identity.service.js');
  const app = initializeApp(
    {
      projectId: 'demo-musicmute',
      credential: {
        getAccessToken: async () => {
          throw new Error(
            'No upstream credentials are allowed in signature tests',
          );
        },
      },
    },
    'musicmute-local-crypto-test',
  );
  try {
    const auth = getAuth(app);
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    // Intercept certificate transport only. Signature and claim verification remain
    // the actual pinned SDK implementation. No fixture switch enters app source.
    const verifier = Reflect.get(auth, 'idTokenVerifier');
    const signatureVerifier = Reflect.get(verifier, 'signatureVerifier');
    const keyFetcher = Reflect.get(signatureVerifier, 'keyFetcher');
    assert.ok(
      keyFetcher,
      'SDK certificate transport shape changed; update the fixture, never skip verification',
    );
    keyFetcher.fetchPublicKeys = async () => ({
      'fixture-key': publicKey.export({ type: 'spki', format: 'pem' }),
    });
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: 'https://securetoken.google.com/demo-musicmute',
      aud: 'demo-musicmute',
      sub: 'fixture-user',
      iat: now - 5,
      exp: now + 3600,
      auth_time: now - 5,
      firebase: { sign_in_provider: 'password', identities: {} },
      email_verified: false,
    };
    const encode = (data) =>
      Buffer.from(JSON.stringify(data)).toString('base64url');
    const issue = (payload) => {
      const data = `${encode({ alg: 'RS256', kid: 'fixture-key', typ: 'JWT' })}.${encode(payload)}`;
      return `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
    };
    const firebase = new FirebaseIdentityService(auth);
    const valid = issue(claims);
    assert.equal((await firebase.verifySignature(valid)).uid, 'fixture-user');
    for (const altered of [
      { ...claims, aud: 'another-project' },
      { ...claims, iss: 'https://untrusted.invalid/demo-musicmute' },
      { ...claims, exp: now - 10 },
      { ...claims, sub: '' },
    ]) {
      await assert.rejects(
        firebase.verifySignature(issue(altered)),
        (error) => error.getStatus() === 401,
      );
    }
    const [header, , signature] = valid.split('.');
    const forged = `${header}.${encode({ ...claims, email_verified: true })}.${signature}`;
    await assert.rejects(
      firebase.verifySignature(forged),
      (error) => error.getStatus() === 401,
    );
  } finally {
    await deleteApp(app);
  }
});
