import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { globals: true, include: ['test/**/*.test.ts'], setupFiles: ['test/helpers/setup-lang.ts'], testTimeout: 30_000, hookTimeout: 30_000 } });
