import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    // Integration tests bind real sockets; serialising avoids port churn.
    fileParallelism: false,
    reporters: ['default'],
  },
});
