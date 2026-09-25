import { test, expect, openApp, showResults, waitForModel, starterAssets, PIN_KEY } from './helpers.mjs';

test('pinning survives sorting, year changes and reload; unpin and clear setup remove the saved choice', async ({ page }) => {
  await openApp(page);
  await showResults(page);
  const table = page.locator('#assetBreakdownTable');
  const key = 'Example stock::taxable::stock';
  await table.getByRole('button', { name: 'Pin Example stock to the top', exact: true }).click();
  await expect(table.locator('tbody tr').first()).toHaveAttribute('data-asset-row-key', key);
  await expect(table.getByRole('button', { name: 'Unpin Example stock', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(k => localStorage.getItem(k), PIN_KEY)).toBe(key);

  await table.locator('th').filter({ has: page.locator('[data-pin-header="Asset"]') }).click();
  await expect(table.locator('tbody tr').first()).toHaveAttribute('data-asset-row-key', key);
  await page.locator('#yearScrubNext').click();
  await expect(page.locator('#yearRange')).toHaveValue('2');
  await expect(table.locator('tbody tr').first()).toHaveAttribute('data-asset-row-key', key);
  await page.reload();
  await waitForModel(page);
  await expect(table.locator('tbody tr').first()).toHaveAttribute('data-asset-row-key', key);
  await table.getByRole('button', { name: 'Unpin Example stock', exact: true }).click();
  await expect(table.locator('.pinned-asset-row')).toHaveCount(0);
  expect(await page.evaluate(k => localStorage.getItem(k), PIN_KEY)).toBeNull();

  await table.getByRole('button', { name: 'Pin Example stock to the top', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#resultsClearSetup').click();
  await expect(page.locator('body')).toHaveAttribute('data-screen', 'persona');
  expect(await page.evaluate(k => localStorage.getItem(k), PIN_KEY)).toBeNull();
});

test('the pinned row stays sticky at the measured header after resize and preserves table scroll on year change', async ({ page }) => {
  const assets = Array.from({ length: 30 }, (_, i) => ({
    ...starterAssets[0], id: `cash-${i}`, name: `Example cash ${String(i).padStart(2, '0')}`, units: 10000 + i
  }));
  await openApp(page, { assets });
  await showResults(page);
  const table = page.locator('#assetBreakdownTable');
  await table.getByRole('button', { name: 'Pin Example cash 05 to the top', exact: true }).click();
  // Resize the browser/table to force overflow in both axes, then let the real
  // ResizeObserver update sticky offsets. No layout mocks are used.
  await page.setViewportSize({ width: 780, height: 800 });
  await table.evaluate(el => { el.style.height = '260px'; });
  await expect.poll(() => table.evaluate(el =>
    parseFloat(getComputedStyle(el).getPropertyValue('--pinned-asset-row-top')) === el.querySelector('thead').offsetHeight
  )).toBe(true);
  const before = await table.evaluate(el => {
    el.scrollTop = 120; el.scrollLeft = 120;
    return { top: el.scrollTop, left: el.scrollLeft };
  });
  expect(before.top).toBeGreaterThan(0);
  expect(before.left).toBeGreaterThan(0);
  await expect(table.locator('.pinned-asset-row td').first()).toHaveCSS('position', 'sticky');
  // Changing the shared year control exercises the same handler as the scrubber,
  // without Playwright auto-scrolling a distant button and disturbing the table.
  await page.locator('#yearRange').evaluate(el => {
    el.value = '2'; el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(() => table.evaluate(el => ({ top: el.scrollTop, left: el.scrollLeft }))).toEqual(before);
  const geometry = await table.evaluate(el => ({
    headerBottom: el.querySelector('thead th').getBoundingClientRect().bottom,
    pinnedTop: el.querySelector('.pinned-asset-row td').getBoundingClientRect().top,
    proxyLeft: el.querySelector('.sticky-x-scroll-track').scrollLeft,
    left: el.scrollLeft
  }));
  expect(Math.abs(geometry.headerBottom - geometry.pinnedTop)).toBeLessThanOrEqual(2);
  expect(geometry.proxyLeft).toBe(geometry.left);
});

test('a pinned depleted holding remains visible in later years with a zero balance', async ({ page }) => {
  const assets = [
    { ...starterAssets[0], id: 'small-cash', name: 'Small cash', units: 50 },
    { ...starterAssets[0], id: 'roth-cash', name: 'Roth cash', accountType: 'roth', accountSubtype: 'rothIra', units: 1000000 }
  ];
  await openApp(page, { assets, controls: { currentAge: '65', socialSecurityAnnualBenefit: '0', rothBasisOptimization: false } });
  await showResults(page);
  const table = page.locator('#assetBreakdownTable');
  await table.getByRole('button', { name: 'Pin Small cash to the top', exact: true }).click();
  await page.locator('#yearRange').press('End');
  const pinned = table.locator('tbody tr').first();
  await expect(pinned).toHaveAttribute('data-asset-row-key', 'Small cash::taxable::cash');
  await expect(pinned.locator('td').nth(5)).toHaveText('$0');
  await expect(pinned.getByRole('button', { name: 'Unpin Small cash', exact: true })).toHaveAttribute('aria-pressed', 'true');
});
