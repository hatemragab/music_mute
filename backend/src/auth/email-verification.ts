import type { SupportedProvider } from './auth.types.js';

const trustedEmailProviders: readonly SupportedProvider[] = [
  'google.com',
  'apple.com',
];

export function isEmailVerifiedForSignInProvider(
  firebaseVerified: boolean,
  provider: SupportedProvider,
): boolean {
  return firebaseVerified || trustedEmailProviders.includes(provider);
}
