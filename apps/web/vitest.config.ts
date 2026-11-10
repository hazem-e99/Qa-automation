import { defineConfig } from 'vitest/config';

// Browser tests in e2e/ belong to Playwright (pnpm e2e), not Vitest.
export default defineConfig({ test: { include: ['src/**/*.test.{ts,tsx}'], passWithNoTests: true } });
