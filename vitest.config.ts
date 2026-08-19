import { defineConfig } from 'vitest/config';

/**
 * Unit tests only — the schedule maths, storage validation and defaults
 * (tasks.md 2.3, 3.1, 3.4, 3.5). Anything needing a real browser lives in the
 * manual matrices (tasks.md 4.3, 7.1).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
});
