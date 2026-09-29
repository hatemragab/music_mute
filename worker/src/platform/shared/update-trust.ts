export const BUILT_IN_UPDATE_TRUST: Readonly<Record<string, string>> =
  Object.freeze({
    "worker-release-2026-01": `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAyvKiex1Pd72WMrIatuQ4JtNmeFZx+yYNa3gZZrDb6IA=
-----END PUBLIC KEY-----
`,
    "worker-release-2026-09": `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAxqTXgndqBXIAA8Glr46bf0fK4eppjHhgLKoqhjghoVY=
-----END PUBLIC KEY-----
`,
  });

export function parseUpdateTrust(
  record: Record<string, unknown>,
): Record<string, string> {
  if (Object.keys(record).length < 1 || Object.keys(record).length > 8)
    throw new TypeError("Update trust store is empty or too large");
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(key) ||
      typeof value !== "string" ||
      value.length > 8192
    )
      throw new TypeError("Update trust store is invalid");
    if (
      BUILT_IN_UPDATE_TRUST[key] !== undefined &&
      BUILT_IN_UPDATE_TRUST[key] !== value
    )
      throw new TypeError("Update trust store cannot replace a built-in key");
    result[key] = value;
  }
  const merged = { ...result, ...BUILT_IN_UPDATE_TRUST };
  if (Object.keys(merged).length > 8)
    throw new TypeError("Update trust store is too large");
  return merged;
}
