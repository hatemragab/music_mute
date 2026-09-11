import { createHash } from 'node:crypto';

export type NameSource = 'email_prefix' | 'numeric_alias';

export function deriveDisplayName(
  uid: string,
  email: string | null,
): { displayName: string; nameSource: NameSource } {
  const address = email?.trim() ?? '';
  const separator = address.lastIndexOf('@');
  const domain = address.slice(separator + 1).toLowerCase();
  const prefix =
    separator > 0
      ? address
          .slice(0, separator)
          .replace(/[\p{Cc}\p{Cf}]/gu, '')
          .trim()
          .slice(0, 128)
          .replace(/[\uD800-\uDBFF]$/u, '')
      : '';
  if (prefix && domain !== 'privaterelay.appleid.com') {
    return { displayName: prefix, nameSource: 'email_prefix' };
  }
  const digest = createHash('sha256')
    .update(`musicmute-name-v1:${uid}`)
    .digest('hex');
  return {
    displayName: BigInt(`0x${digest}`)
      .toString(10)
      .slice(0, 12)
      .padStart(12, '0'),
    nameSource: 'numeric_alias',
  };
}
