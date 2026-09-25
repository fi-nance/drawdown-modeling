import { readFile } from 'node:fs/promises';
import { test, expect, openApp, applyImport, readSetup, payload, jsonFile, showResults, waitForModel, RESULTS_CACHE_KEY } from './helpers.mjs';

test('YTD mode, provenance and quarterly inputs survive reload and setup backup/restore', async ({ page }) => {
  await openApp(page);
  await applyImport(page);
  await page.locator('#monarchYtdEnabled').uncheck();
  await expect(page.locator('#monarchYtdSummary')).toContainText('Disabled:');
  expect((await readSetup(page)).portfolioImport.yearToDateEnabled).toBe(false);
  await page.reload();
  await waitForModel(page);
  await expect(page.locator('#monarchProvenance')).toContainText(payload().exportId);
  await expect(page.locator('#monarchYtdEnabled')).not.toBeChecked();
  await expect(page.locator('#monarchYtdSummary')).toContainText('Disabled:');

  await page.locator('#workspaceSaveSetup').click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export setup', exact: true }).click();
  const download = await downloadEvent;
  const backup = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(backup.state.portfolioImport.yearToDateEnabled).toBe(false);
  expect(backup.state.portfolioImport.yearToDate.quarterlyTax.payments).toEqual(payload().yearToDate.quarterlyTax.payments);

  await page.locator('#monarchYtdEnabled').check();
  expect(await page.evaluate(key => sessionStorage.getItem(key), RESULTS_CACHE_KEY)).toBeNull();
  await page.locator('#restoreSetupFile').setInputFiles(jsonFile(backup, 'fictional-setup.json'));
  await expect(page.locator('#importStatus')).toContainText('Loaded setup from fictional-setup.json');
  await waitForModel(page);
  await expect(page.locator('#monarchYtdEnabled')).not.toBeChecked();
  expect((await readSetup(page)).portfolioImport).toEqual(backup.state.portfolioImport);
});

test('running reviewed YTD shows four quarterly rows; disabling it removes the tax panel on rerun', async ({ page }) => {
  await openApp(page);
  await applyImport(page);
  await showResults(page);
  const panel = page.getByRole('region', { name: 'Federal quarterly tax plan' });
  await expect(panel).toBeVisible();
  await expect(panel.locator('tbody tr')).toHaveCount(4);
  await expect(panel.locator('tbody tr td:first-child')).toHaveText([
    '2026-04-15 · past due', '2026-06-15 · past due', '2026-09-15 · past due', '2027-01-15'
  ]);
  await expect(panel.getByRole('columnheader', { name: 'Recorded coverage', exact: true })).toBeVisible();
  await expect(panel.getByRole('columnheader', { name: 'Forecast coverage', exact: true })).toBeVisible();
  await expect(panel).toContainText('spreadsheet forecast: $20,000.00');
  await expect(page.locator('#yearTable > .assumption-note')).toContainText('2026 starts after 2026-09-22');

  await page.locator('#resultsBackToWorkspace').click();
  await page.locator('#monarchYtdEnabled').uncheck();
  expect(await page.evaluate(key => sessionStorage.getItem(key), RESULTS_CACHE_KEY)).toBeNull();
  await showResults(page);
  await expect(page.locator('#quarterlyTaxPlan')).toBeHidden();
  await expect(page.locator('#quarterlyTaxPlan')).toBeEmpty();
  await expect(page.locator('#yearTable > .assumption-note')).toHaveCount(0);

  await page.locator('#resultsBackToWorkspace').click();
  await page.locator('#monarchYtdEnabled').check();
  await showResults(page);
  await expect(panel).toBeVisible();
  await expect(panel.locator('tbody tr')).toHaveCount(4);
});

test('replacing a YTD import with portfolio-only data clears its mode and quarterly results', async ({ page }) => {
  await openApp(page);
  await applyImport(page);
  await showResults(page);
  await expect(page.locator('#quarterlyTaxPlan')).toBeVisible();
  await page.locator('#resultsBackToWorkspace').click();
  const portfolioOnly = payload();
  portfolioOnly.schemaVersion = 1;
  delete portfolioOnly.yearToDate;
  await applyImport(page, portfolioOnly);
  await expect(page.locator('#monarchYtdControl')).toBeHidden();
  await expect(page.locator('#monarchYtdSummary')).toBeHidden();
  expect((await readSetup(page)).portfolioImport.yearToDate).toBeUndefined();
  await showResults(page);
  await expect(page.locator('#quarterlyTaxPlan')).toBeEmpty();
});
