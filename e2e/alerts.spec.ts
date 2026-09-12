import { main, propertyId, expect, test } from './fixtures';

/** In-app alerts: the feed, and the actions that close the loop. */
test.describe('alerts', () => {
  test('the feed labels which measurement each alert came from', async ({ signedIn: page }) => {
    const id = await propertyId(page);
    await page.goto(`/p/${id}/alerts`);
    await expect(main(page)).toBeVisible();

    const items = main(page).locator('li');
    if ((await items.count()) === 0) {
      // An empty feed is a legitimate state and has its own wording.
      await expect(main(page)).toContainText('Nothing to report');
      return;
    }

    const text = await items.first().innerText();
    expect(/from the rollup|live check|last found check|competitor list/.test(text)).toBe(true);
    // §9's rule, stated where the reader is.
    await expect(main(page)).toContainText('never from a single check');
  });

  test('marking an alert read removes it from the unread count', async ({ signedIn: page }) => {
    const id = await propertyId(page);
    await page.goto(`/p/${id}/alerts`);

    const markRead = page.getByRole('button', { name: 'Mark read' }).first();
    if ((await markRead.count()) === 0) test.skip(true, 'nothing unread to mark');

    const before = await page.locator('[aria-label="unread"]').count();
    await markRead.click();

    await expect
      .poll(async () => page.locator('[aria-label="unread"]').count(), { timeout: 15_000 })
      .toBe(before - 1);
  });

  test('resolving an alert marks it resolved and read', async ({ signedIn: page }) => {
    const id = await propertyId(page);
    await page.goto(`/p/${id}/alerts`);

    const resolve = page.getByRole('button', { name: 'Resolve' }).first();
    if ((await resolve.count()) === 0) test.skip(true, 'nothing open to resolve');

    const before = await page.getByText('resolved', { exact: true }).count();
    await resolve.click();

    await expect
      .poll(async () => page.getByText('resolved', { exact: true }).count(), { timeout: 15_000 })
      .toBe(before + 1);
  });

  test('there is no external delivery channel, and the page says so', async ({
    signedIn: page,
  }) => {
    const id = await propertyId(page);
    await page.goto(`/p/${id}/alerts`);

    // A non-goal worth stating on screen: someone WILL ask where the emails are.
    await expect(main(page)).toContainText('no email or Slack');
  });
});
