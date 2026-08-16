import { defineConfig } from 'vitest/config';
import path from 'node:path';

// process.cwd() instead of import.meta.url: tsconfig.json sets module=CommonJS,
// where import.meta is a compile error and `tsc --noEmit` must stay green.
// Vitest loads this config from the repo root, so cwd is the project root.
const repoRoot = process.cwd();

export default defineConfig({
  resolve: {
    alias: {
      // The ESM export of @strapi/strapi (@strapi/core dist/index.mjs) is
      // broken under Node ESM resolution ("lodash/fp" directory import).
      // Alias to the CommonJS build, which is what Node loads at runtime.
      '@strapi/strapi': path.join(repoRoot, 'node_modules/@strapi/strapi/dist/index.js'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{js,ts}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: [
        'src/index.ts',
        'src/api/site-content/**',
        'src/extensions/**',
        'scripts/validate-transfer.js',
      ],
    },
  },
});
