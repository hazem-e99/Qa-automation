import { defineConfig, devices } from '@playwright/test';

/**
 * Journey tests (doc 24: "E2E in demo mode for journeys"): a real API and database behind the
 * production web build. Needs Docker (Testcontainers) and `pnpm build` first.
 */
const API_PORT = 3101;
const WEB_PORT = 3102;

export default defineConfig({
  testDir: './e2e/journeys',
  outputDir: './test-results/journeys',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: [
    {
      command: 'node e2e/journeys/backend.mjs',
      url: `http://127.0.0.1:${API_PORT}/readyz`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: { JOURNEY_API_PORT: String(API_PORT), JOURNEY_WEB_URL: `http://127.0.0.1:${WEB_PORT}` },
      stdout: 'pipe',
    },
    {
      command: `pnpm exec next start --port ${WEB_PORT} --hostname 127.0.0.1`,
      url: `http://127.0.0.1:${WEB_PORT}/en/login`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        QOS_API_URL: `http://127.0.0.1:${API_PORT}`,
        QOS_WORKER_URL: 'http://127.0.0.1:9',
        QOS_CONTROLLER_URL: 'http://127.0.0.1:9',
        NEXT_TELEMETRY_DISABLED: '1',
      },
    },
  ],
});
