import { defineConfig } from 'vitest/config';

/**
 * Deliberately separate from `vite.config.ts`.
 *
 * That config is `createExtensionConfig` -- a library build aimed at
 * `dist/index.js` with the host's modules externalised. Loading it here would
 * make the test run inherit bundling rules it has no use for, so vitest gets
 * its own file and picks this one up in preference.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
