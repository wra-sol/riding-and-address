import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'vmThreads',
    fileParallelism: false,
    include: ['test/**/*.test.ts']
  }
});
