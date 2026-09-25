import { test, expect, openApp, payload, jsonFile, stage, applyImport, readSetup, readAssets, RESULTS_CACHE_KEY } from './helpers.mjs';

test.beforeEach(async ({ page }) => openApp(page));

test('review is required; cancellation leaves holdings and provenance unchanged', async ({ page }) => {
  const before = await readSetup(page);
  await stage(page);
  const apply = page.getByRole('button', { name: 'Apply reviewed portfolio', exact: true });
  await expect(apply).toBeDisabled();
  expect(await readSetup(page)).toEqual(before);
  await page.locator('#monarchReviewed').check();
  await expect(apply).toBeEnabled();
  await page.locator('#monarchReviewed').uncheck();
  await expect(apply).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('#monarchPreview')).toBeHidden();
  await expect(page.locator('#monarchFile')).toHaveValue('');
  expect(await readSetup(page)).toEqual(before);
});

test('applying replaces holdings, preserves planning controls, records source and invalidates cache', async ({ page }) => {
  const before = await readSetup(page);
  expect(await page.evaluate(key => sessionStorage.getItem(key), RESULTS_CACHE_KEY)).not.toBeNull();
  await applyImport(page);
  const after = await readSetup(page);
  expect(after.assets.map(a => a.id)).toEqual(payload().assets.map(a => a.id));
  expect(after.controls).toEqual(before.controls);
  expect(after.portfolioImport.exportId).toBe(payload().exportId);
  expect(after.portfolioImport.importedAt).toBe('2026-09-24T12:00:00.000Z');
  expect(after.portfolioImport.yearToDate.quarterlyTax.payments).toEqual(payload().yearToDate.quarterlyTax.payments);
  await expect(page.locator('#monarchProvenance')).toContainText(payload().exportId);
  await expect(page.locator('#monarchYtdEnabled')).toBeChecked();
  await expect(page.locator('#monarchYtdSummary')).toContainText('Enabled:');
  expect(await page.evaluate(key => sessionStorage.getItem(key), RESULTS_CACHE_KEY)).toBeNull();
});

test('importing with Remember setup disabled does not persist financial data', async ({ page }) => {
  await page.getByText('Save / Load setup', { exact: true }).click();
  await page.locator('#rememberSetup').uncheck();
  await applyImport(page);
  await expect(page.locator('#monarchProvenance')).toContainText(payload().exportId);
  expect(await readSetup(page)).toBeNull();
  expect(await page.evaluate(key => sessionStorage.getItem(key), RESULTS_CACHE_KEY)).toBeNull();
});

test('the generic JSON loader also requires Monarch review', async ({ page }) => {
  const before = await readAssets(page);
  await page.getByText('JSON editor', { exact: true }).click();
  await page.locator('#assetJson').fill(JSON.stringify(payload()));
  await page.getByRole('button', { name: 'Load JSON', exact: true }).click();
  await expect(page.locator('#monarchPreview')).toBeVisible();
  await expect(page.locator('#applyMonarch')).toBeDisabled();
  expect((await readSetup(page)).assets).toEqual(before);
});

test('edits after preview reject the stale replacement', async ({ page }) => {
  await stage(page);
  await page.locator('#addAsset').click();
  const changed = await readAssets(page);
  await page.locator('#monarchReviewed').check();
  await page.locator('#applyMonarch').click();
  await expect(page.locator('#importStatus')).toContainText('holdings changed');
  expect(await readAssets(page)).toEqual(changed);
  await expect(page.locator('#monarchProvenance')).toBeHidden();
});

test('a file is revalidated at apply time if the review is left open until it expires', async ({ page }) => {
  const before = await readAssets(page);
  await stage(page);
  await page.clock.setFixedTime(new Date('2026-10-10T12:00:00Z'));
  await page.locator('#monarchReviewed').check();
  await page.locator('#applyMonarch').click();
  await expect(page.locator('#importStatus')).toContainText(/stale|old/i);
  expect(await readAssets(page)).toEqual(before);
});

for (const [name, file, error] of [
  ['malformed JSON', () => jsonFile('{broken'), /JSON/i],
  ['oversized files', () => jsonFile(' '.repeat(12 * 1024 * 1024 + 1)), /12 MiB/]
]) {
  test(`${name} clear the prior preview without applying it`, async ({ page }) => {
    const before = await readAssets(page);
    await stage(page);
    await page.locator('#monarchFile').setInputFiles(file());
    await expect(page.locator('#monarchPreview')).toBeHidden();
    await expect(page.locator('#importStatus')).toContainText(error);
    expect(await readAssets(page)).toEqual(before);
  });
}

for (const outcome of ['resolve', 'reject']) {
  test(`a superseded file read cannot ${outcome === 'resolve' ? 'replace the current preview' : 'overwrite current status with an error'}`, async ({ page }) => {
    await page.evaluate(() => {
      const original = File.prototype.text;
      File.prototype.text = function () {
        if (this.name !== 'slow.json') return original.call(this);
        return new Promise((resolve, reject) => { window.finishSlowRead = { resolve, reject }; });
      };
    });
    await page.locator('#monarchFile').setInputFiles(jsonFile(payload(), 'slow.json'));
    const newer = payload();
    newer.exportId = 'dddddddddddddddddddddddddddddddd';
    await stage(page, newer);
    const status = await page.locator('#importStatus').textContent();
    await page.evaluate(({ outcome, raw }) => {
      if (outcome === 'resolve') window.finishSlowRead.resolve(raw);
      else window.finishSlowRead.reject(new Error('Old file read failed'));
    }, { outcome, raw: JSON.stringify(payload()) });
    // Await the file-read continuation, without arbitrary sleeps.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    await expect(page.locator('#monarchPreview')).toContainText(newer.exportId);
    await expect(page.locator('#importStatus')).toHaveText(status);
    await page.locator('#monarchReviewed').check();
    await page.locator('#applyMonarch').click();
    expect((await readSetup(page)).portfolioImport.exportId).toBe(newer.exportId);
  });
}

test('clearing the file selection invalidates a pending read', async ({ page }) => {
  const before = await readAssets(page);
  await page.evaluate(() => {
    File.prototype.text = () => new Promise(resolve => { window.finishRead = resolve; });
  });
  await page.locator('#monarchFile').setInputFiles(jsonFile(payload()));
  await page.locator('#monarchFile').setInputFiles([]);
  await page.evaluate(raw => window.finishRead(raw), JSON.stringify(payload()));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  await expect(page.locator('#monarchPreview')).toBeHidden();
  expect(await readAssets(page)).toEqual(before);
});

test('a current file read failure is reported and can be recovered by selecting a valid file', async ({ page }) => {
  await page.evaluate(() => {
    const original = File.prototype.text;
    File.prototype.text = function () {
      return this.name === 'unreadable.json' ? Promise.reject(new Error('File could not be read')) : original.call(this);
    };
  });
  const before = await readAssets(page);
  await page.locator('#monarchFile').setInputFiles(jsonFile(payload(), 'unreadable.json'));
  await expect(page.locator('#importStatus')).toHaveText('File could not be read');
  await expect(page.locator('#monarchPreview')).toBeHidden();
  expect(await readAssets(page)).toEqual(before);
  await applyImport(page);
});

test('busy price refresh blocks apply until it completes', async ({ page }) => {
  let release;
  const pendingResponse = new Promise(resolve => { release = resolve; });
  await page.route('**/api/price-refresh/yahoo-chart?*', async route => {
    await pendingResponse;
    await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Fictional unavailable quote"}' });
  });
  const before = await readAssets(page);
  await page.locator('#privacyMode').uncheck();
  await stage(page);
  const request = page.waitForRequest('**/api/price-refresh/yahoo-chart?*');
  await page.locator('#refreshPrices').click();
  await request;
  try {
    await page.locator('#monarchReviewed').check();
    await page.locator('#applyMonarch').click();
    await expect(page.locator('#importStatus')).toContainText('Wait for the current simulation or price refresh');
    expect(await readAssets(page)).toEqual(before);
  } finally { release(); }
  await expect(page.locator('#refreshPrices')).toBeEnabled();
  await page.locator('#applyMonarch').click();
  await expect(page.locator('#monarchPreview')).toBeHidden();
});

test('imported account names are rendered as text, never executable markup', async ({ page }) => {
  const data = payload();
  data.accounts[0].name = '<img src=x onerror="window.domInjection=true">';
  await stage(page, data);
  await expect(page.locator('#monarchPreview')).toContainText(data.accounts[0].name);
  await expect(page.locator('#monarchPreview img')).toHaveCount(0);
  expect(await page.evaluate(() => window.domInjection)).toBeUndefined();
});
