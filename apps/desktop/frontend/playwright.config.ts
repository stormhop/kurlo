import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

const slowMoMs = Number.parseInt(process.env.KURLO_E2E_SLOWMO_MS ?? '0', 10);
const slowMo = Number.isFinite(slowMoMs) && slowMoMs > 0 ? slowMoMs : 0;
const serialMode = Boolean(
  slowMo ||
  process.env.PWDEBUG ||
  process.env.KURLO_E2E_STEP_PAUSE_MS ||
  process.env.KURLO_DOCS_SCREENSHOT_DIR ||
  process.env.KURLO_README_SCREENSHOT ||
  process.env.KURLO_E2E_SHOT ||
  process.env.KURLO_E2E_RESPONSE_SCREENSHOT ||
  process.env.KURLO_PERF_FIXTURES ||
  process.env.KURLO_PERF_PROFILE ||
  process.env.KURLO_ROUNDTRIP_IN,
);
const recordArtifacts = Boolean(process.env.CI || process.env.KURLO_E2E_TRACE === '1');
const useDevServer = process.env.KURLO_E2E_SERVER === 'dev';
const localWorkers = Math.min(4, Math.max(1, availableParallelism() - 1));
const workers = serialMode ? 1 : process.env.CI ? 2 : localWorkers;
const artifactDir = process.env.KURLO_E2E_ARTIFACT_DIR ?? join(tmpdir(), 'kurlo-playwright-artifacts');
const bundleDir = join(artifactDir, 'app');
const reporter: PlaywrightTestConfig['reporter'] = process.env.CI || process.env.KURLO_E2E_HTML_REPORT === '1'
  ? [
      ['list'],
      ['./e2e/cleanup-reporter.ts', { artifactDir }],
      ['html', { open: 'never', outputFolder: process.env.KURLO_E2E_REPORT_DIR ?? join(artifactDir, 'html-report') }],
    ]
  : [
      ['list'],
      ['./e2e/cleanup-reporter.ts', { artifactDir }],
    ];

export default defineConfig({
  testDir: './e2e',
  outputDir: join(artifactDir, 'test-results'),
  preserveOutput: 'failures-only',
  timeout: slowMo ? 180_000 : 90_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: !serialMode,
  workers,
  retries: process.env.CI ? 2 : 0,
  reporter,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: recordArtifacts ? 'retain-on-failure' : 'off',
    screenshot: 'only-on-failure',
    video: recordArtifacts ? 'retain-on-failure' : 'off',
    launchOptions: {
      slowMo,
    },
  },
  webServer: {
    command: useDevServer
      ? 'npm run dev -- --host 127.0.0.1 --port 4173 --strictPort'
      : `npx vite build --logLevel warn --outDir "${bundleDir}" --emptyOutDir && npx vite preview --outDir "${bundleDir}" --host 127.0.0.1 --port 4173 --strictPort`,
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: useDevServer && !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        deviceScaleFactor: process.env.KURLO_DOCS_SCREENSHOT_DIR || process.env.KURLO_README_SCREENSHOT ? 2 : 1,
      },
    },
    {
      name: 'webkit',
      use: {
        ...devices['Desktop Safari'],
        deviceScaleFactor: 1,
      },
    },
  ],
});
