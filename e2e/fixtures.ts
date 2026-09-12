import { test as base, expect, type Page } from '@playwright/test';

/**
 * Shared setup: a signed-in page on the demo property.
 *
 * The credentials come from the same environment variables the seed uses, so
 * there is no second source of truth for who the test user is.
 */
export const EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
export const PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? '';

export async function signIn(page: Page) {
  await page.goto('/login');
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  // A single property redirects straight through the picker.
  await page.waitForURL(/\/p\/[0-9a-f-]{36}/, { timeout: 30_000 });
}

export async function propertyId(page: Page): Promise<string> {
  const match = /\/p\/([0-9a-f-]{36})/.exec(page.url());
  expect(match, 'expected to be on a property page').not.toBeNull();
  return match![1]!;
}

/**
 * THE page's main landmark.
 *
 * Next streams: during a navigation the loading skeleton and the page are
 * briefly both in the document. A bare `locator('main')` hits Playwright's
 * strict-mode violation exactly when the page is slowest, which reads as a
 * flake. (The skeleton is a `<div role="status">` for the same reason — two
 * `<main>` landmarks is a document with no main content to a screen reader.)
 */
export function main(page: Page) {
  return page.locator('main').filter({ visible: true }).first();
}

export const test = base.extend<{ signedIn: Page }>({
  signedIn: async ({ page }, use) => {
    await signIn(page);
    await use(page);
  },
});

export { expect };
