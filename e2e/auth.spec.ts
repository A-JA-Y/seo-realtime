import { expect, test } from '@playwright/test';

import { EMAIL, PASSWORD } from './fixtures';

/**
 * Acceptance criterion 6 at the browser level.
 *
 * The tenancy rules are proven against the database in
 * `tenancy.integration.test.ts` and against the route handlers in
 * `tenancy-routes.integration.test.ts`. What is left to prove is that the
 * BROWSER cannot get past them — which is a different question, because it
 * involves middleware, redirects and cookies rather than SQL.
 */
test.describe('authentication', () => {
  test('an anonymous visitor is sent to the login page, not shown a dashboard', async ({ page }) => {
    const response = await page.goto('/');
    await page.waitForURL(/\/login/);

    expect(response?.status()).toBeLessThan(400);
    await expect(page.locator('input[name="password"]')).toBeVisible();
  });

  test('an anonymous API call gets typed JSON, never an HTML login page', async ({ request }) => {
    /*
     * The bug this exists for: the middleware matcher once included `/api`, so
     * an unauthenticated fetch received a 307 to /login and — if it followed
     * redirects, which fetch does by default — a 200 full of markup. To a JSON
     * client that looks like success.
     */
    const response = await request.get('/api/properties', { maxRedirects: 0 });

    expect(response.status()).toBe(401);
    expect(response.headers()['content-type']).toContain('application/json');
    expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  test('a wrong password is refused without saying which half was wrong', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[name="email"]', EMAIL);
    await page.fill('input[name="password"]', 'definitely-not-the-password');
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL(/\/login/);
    const body = (await page.locator('body').innerText()).toLowerCase();
    // Account enumeration: the message must not distinguish "no such user"
    // from "wrong password".
    expect(body).not.toContain('no such');
    expect(body).not.toContain('unknown email');
    expect(body).not.toContain('user not found');
  });

  test('signing in lands on a property', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[name="email"]', EMAIL);
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');

    await page.waitForURL(/\/p\/[0-9a-f-]{36}/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('a property the account cannot read is refused, not 404ed', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[name="email"]', EMAIL);
    await page.fill('input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/p\//, { timeout: 30_000 });

    await page.goto('/p/00000000-0000-4000-8000-000000000000');
    const body = await page.locator('body').innerText();

    // 403, never 404: pretending it does not exist is a different lie to
    // someone reading the id in their own URL bar.
    expect(body.toLowerCase()).toContain('access');
    expect(body.toLowerCase()).not.toContain('not found');
  });
});
