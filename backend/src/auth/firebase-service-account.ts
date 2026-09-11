import type { ServiceAccount } from 'firebase-admin/app';

interface ServiceAccountJson {
  project_id?: unknown;
  client_email?: unknown;
  private_key?: unknown;
}

export function decodeFirebaseServiceAccount(
  encoded: string,
  expectedProjectId: string,
): ServiceAccount {
  try {
    const normalized = encoded.trim();
    const decoded = Buffer.from(normalized, 'base64').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64') !== normalized)
      throw new Error('Invalid base64');

    const value = JSON.parse(decoded) as ServiceAccountJson;
    if (
      typeof value.project_id !== 'string' ||
      !value.project_id ||
      typeof value.client_email !== 'string' ||
      !value.client_email ||
      typeof value.private_key !== 'string' ||
      !value.private_key
    )
      throw new Error('Invalid service account');

    if (value.project_id !== expectedProjectId)
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT_BASE64 project does not match FIREBASE_PROJECT_ID',
      );

    return {
      projectId: value.project_id,
      clientEmail: value.client_email,
      privateKey: value.private_key,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message ===
        'FIREBASE_SERVICE_ACCOUNT_BASE64 project does not match FIREBASE_PROJECT_ID'
    )
      throw error;
    throw new Error('Invalid FIREBASE_SERVICE_ACCOUNT_BASE64');
  }
}
