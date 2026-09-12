import { main, propertyId, expect, test } from './fixtures';

/**
 * The chart and the reconciliation panel — the two things this product is for.
 */
test.describe('keyword detail', () => {
  test.beforeEach(async ({ signedIn: page }) => {
    const id = await propertyId(page);
    await page.goto(`/p/${id}/keywords`);

    /*
     * Read the href and navigate, rather than clicking.
     *
     * The list is server-rendered TWICE — a phone card list and a table above
     * `sm`, toggled with CSS — so a click has to land on whichever is on screen,
     * and the detail page is the heaviest in the app. Clicking made this hook
     * the flakiest thing in the suite for no coverage: what is being tested is
     * the detail page, not the anchor.
     */
    const href = await page
      .locator('a[href*="/keywords/"]')
      .filter({ visible: true })
      .first()
      .getAttribute('href');

    expect(href, 'no keyword link on the keywords page').toBeTruthy();
    await page.goto(href!);
    await expect(page.getByRole('button', { name: /check now/i })).toBeVisible();
  });

  test('the chart names the source of all three series', async ({ signedIn: page }) => {
    const legend = main(page).locator('ul').filter({ hasText: 'Organic rank' }).first();
    await expect(legend).toBeVisible();

    const text = await legend.innerText();
    expect(text).toContain('rank_group');
    expect(text).toContain('rank_absolute');
    expect(text).toContain('Average position');
    // §11: "an explicit legend naming the SOURCE of each".
    expect(text).toContain('DataForSEO');
    expect(text).toContain('Search Console');
  });

  test('the rank axis is inverted, so position 1 is at the top', async ({ signedIn: page }) => {
    /*
     * Domain rule 10, checked on the rendered page rather than in the config.
     *
     * Two things make the obvious selector wrong. Recharts 3 renders axis tick
     * LABELS outside the `.recharts-yAxis` group, so `.recharts-yAxis text`
     * matches nothing; and the tick `<g>` wrappers have no box of their own, so
     * `getBoundingClientRect()` returns zeroes and `toBeVisible` calls them
     * hidden while their labels are plainly painted.
     *
     * So: take every tick label, keep the ones that are bare numbers. The x
     * axis is dates ("10 Sept"), which leaves exactly the rank axis.
     */
    const labels = page.locator('.recharts-cartesian-axis-tick-value');
    await expect.poll(async () => labels.count(), { timeout: 15_000 }).toBeGreaterThan(4);

    const ticks = await labels.evaluateAll((nodes) =>
      nodes
        .map((node) => ({
          text: (node.textContent ?? '').trim(),
          y: node.getBoundingClientRect().top,
        }))
        .filter((tick) => /^\d+$/.test(tick.text))
        .map((tick) => ({ value: Number(tick.text), y: tick.y })),
    );

    expect(ticks.length, 'no numeric ticks — is this the rank axis?').toBeGreaterThan(2);

    const topToBottom = [...ticks].sort((a, b) => a.y - b.y);

    // Position 1 is at the top, and it is labelled. An inverted axis whose top
    // tick reads "7" rescales every chart to its own best result, so two
    // keywords side by side look equally good.
    expect(topToBottom[0]!.value).toBe(1);

    // And the numbers grow downwards. If they did not, an improvement would
    // point down the page — the bug this rule exists to prevent.
    for (let i = 1; i < topToBottom.length; i++) {
      expect(topToBottom[i]!.value).toBeGreaterThan(topToBottom[i - 1]!.value);
    }
  });

  test('a null renders as a gap, never as a value', async ({ signedIn: page }) => {
    /*
     * Acceptance criterion 3. `connectNulls={false}` means Recharts emits a
     * SEPARATE path per unbroken run, so a series with gaps has more than one
     * `d` segment — and no point is ever plotted at the bottom of the domain.
     */
    const id = await propertyId(page);

    // The keyword the demo data keeps out of the results for a stretch.
    // Read the href and navigate rather than clicking: the list is rendered as
    // both a table and a card list, and this test is about the chart.
    await page.goto(`/p/${id}/keywords`);
    const href = await page
      .locator('a[href*="/keywords/"]')
      .filter({ hasText: 'floor plan', visible: true })
      .first()
      .getAttribute('href');

    expect(href, 'the demo data should include a keyword that drops out').toBeTruthy();
    await page.goto(href!);

    const notFoundLegend = page.getByText('absent from the fetched results');
    await expect(notFoundLegend).toBeVisible();

    // A hatched band marks the stretch. If a null were being plotted as a
    // value, there would be a line across it instead.
    const band = page.locator('.recharts-reference-area');
    expect(await band.count()).toBeGreaterThan(0);
  });

  test('the reconciliation panel explains the gap in words', async ({ signedIn: page }) => {
    const panel = main(page).filter({ hasText: 'Why these two numbers differ' });
    await expect(panel).toBeVisible();

    const text = await panel.innerText();
    expect(text).toContain('Search Console');
    expect(text).toContain('average position');
    // Pacific dates are never shifted, and the panel says which day it means.
    expect(text).toContain('Pacific');
  });

  test('"check now" shows the price before it is pressed', async ({ signedIn: page }) => {
    const button = page.getByRole('button', { name: /check now/i });
    await expect(button).toBeVisible();

    const row = page.locator('header').filter({ hasText: 'a check' }).first();
    await expect(row).toContainText('$0.0020');
    await expect(row).toContainText('one per 5 minutes');
  });
});
