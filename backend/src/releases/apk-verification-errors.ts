export const APK_REJECTION_CODES = [
  'APK_INVALID',
  'APK_IDENTITY_MISMATCH',
  'APK_SIGNER_UNTRUSTED',
  'APK_CHECKSUM_MISMATCH',
  'APK_SIZE_MISMATCH',
  'APK_VERIFIER_UNAVAILABLE',
  'APK_VERIFICATION_TIMEOUT',
] as const;
export type ApkRejectionCode = (typeof APK_REJECTION_CODES)[number];

export function safeApkRejectionCode(value: unknown): ApkRejectionCode | null {
  if (value === null || value === undefined) return null;
  return APK_REJECTION_CODES.includes(value as ApkRejectionCode)
    ? (value as ApkRejectionCode)
    : 'APK_INVALID';
}
