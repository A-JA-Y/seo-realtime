import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests (§12).
 *
 * These drive a REAL browser against a REAL server against a REAL database.
 * That is the point: the unit and integration suites prove the rules, and this
 * proves the rules are actually wired to the screen. Every defect it has caught
 * so far was of that shape — correct logic that no page called.
 *
 * It runs against the demo data (`pnpm db:demo`), which deliberately contains
 * the awkward cases: gaps, a not-found stretch, a ranking-URL change and two
 * locations that disagree. A fixture that only contains happy rows proves the
 * happy path renders, which was never in doubt.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // Serial. The specs mutate shared rows (marking alerts read), and a suite
  // that races itself reports flakes that look like product bugs.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    /*
     * Set PLAYWRIGHT_CHROMIUM_EXECUTABLE when the browser is already on the
     * machine at a path Playwright's own version pinning does not expect —
     * a container image that ships one, typically. Left unset (CI, a normal
     * laptop) Playwright resolves its own download as usual.
     */
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } }
      : {}),
  },

  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // Clients read these on a phone. The keyword table becomes a card list
    // below `sm`, and that swap is exactly the kind of thing that silently
    // breaks.
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],

  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `pnpm build && pnpm start --port ${PORT}`,
        url: `${baseURL}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        /*
         * AUTH_URL must match the origin the browser actually uses, exactly.
         * Auth.js builds its callback and redirect URLs from it, so a server
         * on :3100 with AUTH_URL pointing at :3000 signs the user in and then
         * sends them to a port nothing is listening on —
         * `ERR_CONNECTION_REFUSED` after a successful login, which reads like a
         * broken app rather than a configuration mismatch. Overriding both here
         * means `pnpm test:e2e` works whatever `.env.local` says.
         */
        env: { AUTH_URL: baseURL, APP_BASE_URL: baseURL },
      },
});
