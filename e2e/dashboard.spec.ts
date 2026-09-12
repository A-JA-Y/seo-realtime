import { main, propertyId, expect, test } from './fixtures';

/**
 * The acceptance criteria that are only checkable on screen.
 *
 * Criterion 7 — "every position number rendered anywhere in the UI is labelled
 * with its source" — cannot be proven by a unit test, because it is a claim
 * about the rendered page. Neither can criterion 3, that a null renders as a
 * gap rather than a zero.
 */
test.describe('dashboard', () => {
  test('the overview labels the source of every tile', async ({ signedIn: page }) => {
    const tiles = page.locator('main section >> div.rounded-xl');
    await expect(tiles.first()).toBeVisible();

    const count = await tiles.count();
    expect(count).toBeGreaterThanOrEqual(4);

    for (let i = 0; i < count; i++) {
      const text = await tiles.nth(i).innerText();
      expect(
        /live rank check|Search Console average|configuration/.test(text),
        `tile ${i} carries no source label:\n${text}`,
      ).toBe(true);
    }
  });

  test('the keyword list shows both measurements, separately labelled', async ({
    signedIn: page,
  }) => {
    const body = await main(page).innerText();

    expect(body).toContain('live rank check');
    expect(body).toContain('Search Console average');
    // Domain rule 1 in the user's own words.
    expect(body).toContain('never combined');
  });

  test('a keyword absent from the results reads "not found", never 100', async ({
    signedIn: page,
  }) => {
    const id = await propertyId(page);
    await page.goto(`/p/${id}/keywords`);
    await expect(main(page)).toBeVisible();

    /*
     * `visible: true` is load-bearing. The keyword list is server-rendered
     * TWICE — a card list for phones and a table above `sm`, toggled with CSS
     * so there is no layout shift and no client-side branch. `.first()` without
     * this filter resolves to whichever is hidden at the current width.
     */
    const notFound = page.getByText('not found', { exact: true }).filter({ visible: true });
    await expect(notFound.first()).toBeVisible();

    /*
     * The demo data keeps one keyword out of the top 100 right now. Domain rule
     * 5: it is an absence, never the sentinel 100 — and a sentinel would show up
     * as a position beside the "not found" badge on the very same row.
     */
    const row = notFound.first().locator('xpath=ancestor::*[self::tr or self::li][1]');
    await expect(row).not.toContainText('#100');
  });

  test('competitors are ranked from live checks only', async ({ signedIn: page }) => {
    const id = await propertyId(page);
    await page.goto(`/p/${id}/competitors`);

    await expect(page.getByText('Competitors', { exact: true }).first()).toBeVisible();
    const body = await main(page).innerText();
    expect(body).toContain('live rank check');
    // Search Console knows nothing about anyone else's site, and the page says so.
    expect(body).toContain('Search Console has nothing to say');
  });

  test('every page keeps its numbers on screen at phone width', async ({ signedIn: page }) => {
    const id = await propertyId(page);

    for (const path of ['', '/keywords', '/competitors', '/alerts']) {
      await page.goto(`/p/${id}${path}`);
      await expect(main(page)).toBeVisible();

      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      expect(overflows, `${path || '/'} scrolls horizontally`).toBe(false);
    }
  });
});
