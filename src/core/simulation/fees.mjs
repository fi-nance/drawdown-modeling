import { marketValue } from '../portfolio.mjs';
import { round } from '../utils.mjs';

export function annualAdvisoryFees(portfolio, scenario) {
  const config = scenario.fees ?? {};
  const rate = value => Math.max(0, Math.min(0.1, Number(value) || 0));
  return round(portfolio.reduce((sum, asset) => sum + marketValue(asset)
    * rate(config.accountRates?.[asset.accountType] ?? config.advisoryRate), 0), 6);
}

export function applyFundExpenses(portfolio, scenario) {
  const config = scenario.fees ?? {};
  if (config.returnsNetOfFundExpenses !== false) return 0;
  const rate = Math.max(0, Math.min(0.1, Number(config.fundExpenseRate) || 0));
  let expenses = 0;
  for (const asset of portfolio) {
    // Individually held TIPS ladder securities have no mutual-fund NAV fee.
    if (asset.tipsLadderYear != null) continue;
    expenses += marketValue(asset) * rate;
    asset.price = round(asset.price * (1 - rate), 8);
  }
  return round(expenses, 6);
}
