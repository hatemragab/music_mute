import { ConfigService } from '@nestjs/config';
import { ProcessingStartupService } from './processing-startup.service.js';

function fixture(enabled: boolean, hello: Record<string, unknown>) {
  const command = vi.fn().mockResolvedValue(hello);
  const model = vi.fn(() => ({ init: vi.fn().mockResolvedValue(undefined) }));
  const connection = { db: { admin: () => ({ command }) }, model };
  const assertReady = vi.fn().mockResolvedValue(undefined);
  return {
    command,
    model,
    assertReady,
    startup: new ProcessingStartupService(
      connection as never,
      new ConfigService({ AUDIO_PROCESSING_ENABLED: enabled }),
      { assertReady } as never,
    ),
  };
}

describe('processing startup prerequisites', () => {
  it('identifies the MongoDB capability stage without provider diagnostics', async () => {
    const f = fixture(true, {});
    f.command.mockRejectedValue(new Error('private connection details'));
    await expect(f.startup.onModuleInit()).rejects.toThrow(
      'Audio processing MongoDB capability check failed',
    );
    expect(f.model).not.toHaveBeenCalled();
    expect(f.assertReady).not.toHaveBeenCalled();
  });
  it('fails closed when the private storage preflight fails', async () => {
    const f = fixture(true, {
      setName: 'rs',
      isWritablePrimary: true,
      logicalSessionTimeoutMinutes: 30,
    });
    f.assertReady.mockRejectedValue(new Error('unsafe storage'));
    await expect(f.startup.onModuleInit()).rejects.toThrow('unsafe storage');
  });
  it('does not require transactions or processing initialization while disabled', async () => {
    const f = fixture(false, {});
    await expect(f.startup.onModuleInit()).resolves.toBeUndefined();
    expect(f.command).not.toHaveBeenCalled();
    expect(f.model).not.toHaveBeenCalled();
    expect(f.assertReady).not.toHaveBeenCalled();
  });
  it('rejects enabled processing on a standalone MongoDB', async () => {
    await expect(
      fixture(true, { isWritablePrimary: true }).startup.onModuleInit(),
    ).rejects.toThrow('replica set');
  });
  it('requires a writable primary and sessions', async () => {
    await expect(
      fixture(true, {
        setName: 'rs',
        isWritablePrimary: false,
        logicalSessionTimeoutMinutes: 30,
      }).startup.onModuleInit(),
    ).rejects.toThrow('replica set');
  });
  it('awaits processing schema initialization before startup completes', async () => {
    const f = fixture(true, {
      setName: 'rs',
      isWritablePrimary: true,
      logicalSessionTimeoutMinutes: 30,
    });
    f.model.mockImplementation(() => ({
      init: vi.fn().mockRejectedValue(new Error('index conflict')),
    }));
    await expect(f.startup.onModuleInit()).rejects.toThrow(
      'Audio processing schema initialization failed',
    );
    expect(f.assertReady).not.toHaveBeenCalled();
  });
});
