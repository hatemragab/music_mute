import { describe, expect, it, vi } from 'vitest';
import type { Model } from 'mongoose';
import { ReleaseUploadService } from './release-upload.service.js';
import type { ReleaseUpload } from './release-upload.schema.js';

describe('historical upload status', () => {
  const id = 'a'.repeat(24),
    uploadId = 'b'.repeat(24);
  it('reads only bounded status and hides stored object identities', async () => {
    const uploads = {
      findOne: vi.fn(() => ({
        maxTimeMS: vi.fn(() => ({
          lean: async () => ({
            artifactState: 'verified',
            code: null,
            checkedAt: new Date(0),
            key: 'private.apk',
            etag: 'private',
          }),
        })),
      })),
    };
    const service = new ReleaseUploadService(
      uploads as unknown as Model<ReleaseUpload>,
    );
    expect(await service.read(id, uploadId)).toEqual({
      artifactState: 'verified',
      checkedAt: new Date(0).toISOString(),
    });
    expect('reserve' in service).toBe(false);
    expect('complete' in service).toBe(false);
  });
  it('rejects malformed ids and missing historical uploads', async () => {
    const uploads = {
      findOne: vi.fn(() => ({ maxTimeMS: () => ({ lean: async () => null }) })),
    };
    const service = new ReleaseUploadService(
      uploads as unknown as Model<ReleaseUpload>,
    );
    await expect(service.read('bad', uploadId)).rejects.toMatchObject({
      status: 400,
    });
    expect(uploads.findOne).not.toHaveBeenCalled();
    await expect(service.read(id, uploadId)).rejects.toMatchObject({
      status: 404,
    });
  });
});
