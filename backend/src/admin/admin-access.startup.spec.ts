import { describe, expect, it, vi } from 'vitest';
import { AdminAccessStartup } from './admin-access.startup.js';

describe('AdminAccessStartup', () => {
  it('awaits the administrator access indexes before startup completes', async () => {
    const init = vi.fn(async () => undefined);
    const startup = new AdminAccessStartup({ init } as never);
    await startup.onModuleInit();
    expect(init).toHaveBeenCalledOnce();
  });
});
