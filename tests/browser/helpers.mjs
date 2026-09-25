import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { RESULTS_CACHE_KEY } from '../../src/core/resultsCache.mjs';

export { expect, RESULTS_CACHE_KEY };
export const SETUP_KEY = 'portfolio-success-lab:v3';
export const PIN_KEY = 'portfolio-success-lab:pinned-asset-row';
export const payload = () => JSON.parse(readFileSync(new URL('../fixtures/monarch-quarterly.json', import.meta.url), 'utf8'));
export const jsonFile = (value, name = 'fictional-portfolio.json') => ({
  name, mimeType: 'application/json', buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
});

// Each browser context is disposable. Only checked-in or generated fictional data
// enters it, and external requests are blocked before navigation.
export const test = base.extend({
  page: async ({ page, context, baseURL }, use) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === baseURL ? route.continue() : route.abort();
    });
    // Hold the date fixed, but leave timers running. Export freshness must not
    // start failing just because the calendar advances beyond this fixture.
    await page.clock.setFixedTime(new Date('2026-09-24T12:00:00Z'));
    await page.addInitScript(() => {
      window.domTestRunComplete = false;
      window.domTestRunError = null;
      window.addEventListener('psl:run-progress', event => {
        if (event.detail.phase === 'preparing') window.domTestRunComplete = false;
        if (event.detail.error) window.domTestRunError = document.querySelector('#status')?.textContent;
      });
      window.addEventListener('psl:run-complete', () => { window.domTestRunComplete = true; });
    });
    await use(page);
    expect(errors, 'Uncaught browser errors').toEqual([]);
  }
});

export const starterAssets = [
  { id: 'demo-cash', name: 'Example cash', accountType: 'taxable', assetClass: 'cash', units: 1000000, price: 1, costBasisPerUnit: 1, dividendYield: 0, qualifiedDividendShare: 0, holdingPeriod: 'long' },
  { id: 'demo-stock', name: 'Example stock', symbol: 'DEMO', accountType: 'taxable', assetClass: 'stock', units: 10, price: 100, costBasisPerUnit: 90, dividendYield: 0, qualifiedDividendShare: 1, holdingPeriod: 'long' }
];

export async function openApp(page, { assets = starterAssets, controls = {} } = {}) {
  const setup = {
    assets,
    controls: {
      planYears: '3', targetSpend: '1000', currentAge: '50', spouseAge: '', filingStatus: 'single',
      runs: '10', seed: '42', privacyMode: true, acaEnabled: false, medicarePremiumsEnabled: false,
      withdrawalStrategyMode: 'heuristic', backtestMode: 'specific', historicalStartYear: '2020',
      historicalEndYear: '2025', taxLossHarvesting: false, taxGainHarvesting: false, rothConversion: false,
      ...controls
    },
    oneOffExpenses: [], conditionalAssetSales: [], incomeStreams: []
  };
  await page.addInitScript(({ setup, key }) => {
    // Do not reseed on reload: reload tests must exercise the app's persistence.
    if (sessionStorage.getItem('dom-test-initialized')) return;
    sessionStorage.setItem('dom-test-initialized', 'true');
    localStorage.setItem(key, JSON.stringify(setup));
    localStorage.setItem('portfolio-success-lab:remember-setup', 'true');
    localStorage.setItem('psl:redesign:screen', 'workspace');
  }, { setup, key: SETUP_KEY });
  await page.goto('/?screen=workspace');
  await expect(page.locator('body')).toHaveAttribute('data-screen', 'workspace');
  await waitForModel(page);
}

export async function waitForModel(page) {
  await expect.poll(() => page.evaluate(() => window.domTestRunError || Boolean(window.domTestRunComplete && window.__pslLatest?.monteCarlo?.progress?.complete)), { timeout: 30_000 }).toBe(true);
  await expect(page.locator('#runOverlay')).toBeHidden();
}

export async function stage(page, value = payload()) {
  await page.locator('#monarchFile').setInputFiles(jsonFile(value));
  await expect(page.locator('#monarchPreview')).toBeVisible();
}

export async function applyImport(page, value = payload()) {
  await stage(page, value);
  await page.locator('#monarchReviewed').check();
  await page.getByRole('button', { name: 'Apply reviewed portfolio', exact: true }).click();
  await expect(page.locator('#monarchPreview')).toBeHidden();
  await expect(page.locator('#importStatus')).toContainText('Reviewed Monarch portfolio applied');
}

export const readSetup = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), SETUP_KEY);
export const readAssets = page => page.locator('#assetJson').inputValue().then(raw => JSON.parse(raw).assets);

export async function showResults(page) {
  await page.locator('#wsViewResults').click();
  await expect(page.locator('body')).toHaveAttribute('data-screen', 'results');
  await waitForModel(page);
}
