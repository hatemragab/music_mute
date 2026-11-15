export interface GuestCredential {
  token: string;
  expires_at: string;
}
export interface GuestCredentialStore {
  load(): Promise<GuestCredential | null>;
  save(credential: GuestCredential): Promise<void>;
}
export function validGuestCredential(value: unknown): value is GuestCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).length === 2 &&
    typeof row.token === "string" &&
    /^[A-Za-z0-9_-]{43,128}(?![\s\S])/.test(row.token) &&
    typeof row.expires_at === "string" &&
    row.expires_at.length <= 40 &&
    Number.isFinite(Date.parse(row.expires_at))
  );
}
