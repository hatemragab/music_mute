import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const tokenDigest = (token: string) =>
  createHash('sha256').update(token, 'utf8').digest('hex');
export function equalDigest(a: string, b: string) {
  return (
    a.length === 64 &&
    b.length === 64 &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
export function pairingCode(
  secret: string,
  installationId: string,
  nonce: string,
) {
  const bytes = createHmac('sha256', secret)
    .update(`musicmute-installation-code-v1\0${installationId}\0${nonce}`)
    .digest();
  let bits = BigInt(`0x${bytes.subarray(0, 7).toString('hex')}`) >> 6n;
  let code = '';
  for (let i = 0; i < 10; i++) {
    code = alphabet[Number(bits & 31n)] + code;
    bits >>= 5n;
  }
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}
export function codeLookup(secret: string, code: string) {
  return createHmac('sha256', secret)
    .update(`musicmute-installation-lookup-v1\0${code}`)
    .digest('hex');
}
