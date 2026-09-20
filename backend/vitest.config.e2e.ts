import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  plugins: [swc.vite()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Nest test applications share process and reflection state; serial files
    // keep one harness from changing another harness while requests are active.
    fileParallelism: false,
  },
});
