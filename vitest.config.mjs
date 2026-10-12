// Vitest configuration: the tests live in test/ as plain ES modules and run in Node, the same
// runtime the scripts use on a caller's runner.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.mjs'],
    environment: 'node',
  },
});
