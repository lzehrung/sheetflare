import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/lib/**/*.test.ts'],
    pool: 'forks'
  }
});
