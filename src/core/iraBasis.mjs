import { round } from './utils.mjs';

export const IRA_SUBTYPES = ['traditionalIra', 'sepIra', 'simpleIra'];
export const ACCOUNT_SUBTYPES = {
  taxable: ['brokerage'], traditional: [...IRA_SUBTYPES, '401k', '403b', 'governmental457b'],
  roth: ['rothIra', 'roth401k', 'roth403b'], hsa: ['hsa']
};
const ownerOf = asset => asset.owner === 'spouse' ? 'spouse' : 'primary';
const valueOf = asset => Math.max(0, asset.units ?? 0) * Math.max(0, asset.price ?? 0);
export function accountSubtype(asset) {
  return asset.accountSubtype ?? ACCOUNT_SUBTYPES[asset.accountType]?.[0];
}
export function isTraditionalIra(asset) {
  return asset.accountType === 'traditional' && IRA_SUBTYPES.includes(accountSubtype(asset));
}
export function prepareRetirementAccounts(assets) {
  return assets.map(asset => {
    const subtype = accountSubtype(asset);
    if (!ACCOUNT_SUBTYPES[asset.accountType]?.includes(subtype)) throw new RangeError(`Invalid account subtype for ${asset.name ?? asset.id}.`);
    if (['traditional','roth','hsa'].includes(asset.accountType) && asset.owner === 'joint') throw new RangeError('Retirement accounts require an individual owner.');
    if (asset.rolloverToIraAtStart === true && ['traditional', 'roth'].includes(asset.accountType)) {
      return { ...asset, accountSubtype: asset.accountType === 'roth' ? 'rothIra' : 'traditionalIra' };
    }
    if (['roth401k', 'roth403b'].includes(subtype)) throw new RangeError('Designated Roth employer-plan distributions require an explicit completed rollover to a Roth IRA before this plan starts.');
    if (asset.accountType === 'traditional' && !IRA_SUBTYPES.includes(subtype) && Number(asset.nondeductibleBasis) > 0) throw new RangeError('After-tax employer-plan basis is not IRA basis. Model the completed rollover and its actual tax basis.');
    return { ...asset };
  });
}

function attach(portfolio, ledger) {
  Object.defineProperty(portfolio, 'iraLedger', { value: ledger, writable: true, configurable: true, enumerable: false });
  return ledger;
}
export function copyIraLedger(target, source) {
  if (source.iraLedger) attach(target, structuredClone(source.iraLedger));
  return target;
}
export function ensureIraLedger(portfolio, scenario = {}) {
  if (portfolio.iraLedger) return portfolio.iraLedger;
  const ledger = { ownerAliases: {}, primary: { basis: 0 }, spouse: { basis: 0 } };
  for (const owner of ['primary', 'spouse']) {
    const grouped = new Map();
    for (const asset of portfolio.filter(a => isTraditionalIra(a) && ownerOf(a) === owner)) {
      if (asset.nondeductibleBasis == null) continue;
      const basis = Number(asset.nondeductibleBasis);
      if (!Number.isFinite(basis) || basis < 0) throw new RangeError('IRA nondeductible basis must be finite and nonnegative.');
      const id = asset.accountId ?? asset.id;
      if (grouped.has(id) && grouped.get(id) !== basis) throw new RangeError('Conflicting nondeductible basis for one IRA account.');
      grouped.set(id, basis);
    }
    const imported = [...grouped.values()].reduce((a, b) => a + b, 0);
    const entered = Number(scenario[owner === 'primary' ? 'traditionalIraBasis' : 'spouseTraditionalIraBasis'] ?? 0);
    if (!Number.isFinite(entered) || entered < 0) throw new RangeError('IRA basis must be finite and nonnegative.');
    if (entered > 0 && imported > 0 && Math.abs(entered - imported) > 0.01) throw new RangeError('Imported IRA basis and the owner total disagree. Enter the same total or use only one source.');
    ledger[owner].basis = entered || imported;
  }
  return attach(portfolio, ledger);
}
export function rolloverIraLedger(portfolio, deceasedOwner) {
  const ledger = ensureIraLedger(portfolio);
  if (ledger.ownerAliases[deceasedOwner]) return;
  const survivor = deceasedOwner === 'primary' ? 'spouse' : 'primary';
  ledger[survivor].basis += ledger[deceasedOwner].basis;
  ledger[deceasedOwner].basis = 0;
  ledger.ownerAliases[deceasedOwner] = survivor;
}

// Returns are applied before annual distributions in this engine. Thus this
// balance equals Dec 31 IRA value plus that year's gross IRA distributions
// and conversions (Form 8606 lines 6-9). Trading within an IRA does not change it.
export function beginIraTaxYear(portfolio) {
  const ledger = ensureIraLedger(portfolio);
  for (const owner of ['primary', 'spouse']) {
    const denominator = portfolio.reduce((sum, asset) => sum + (isTraditionalIra(asset)
      && (ledger.ownerAliases[ownerOf(asset)] ?? ownerOf(asset)) === owner ? valueOf(asset) : 0), 0);
    ledger[owner].year = { openingBasis: ledger[owner].basis, denominator,
      nontaxableRatio: denominator > 0 ? Math.min(1, ledger[owner].basis / denominator) : 0,
      distributions: 0, conversions: 0, basisUsed: 0, nontaxableConversions: 0 };
  }
}
export function iraDistributionTax(portfolio, asset, gross, { consume = false, conversion = false } = {}) {
  if (!isTraditionalIra(asset) || !portfolio.iraLedger) return { taxable: gross, nontaxable: 0 };
  const ledger = portfolio.iraLedger;
  const history = ledger[ledger.ownerAliases[ownerOf(asset)] ?? ownerOf(asset)];
  const nontaxable = Math.min(gross, history.basis, round(gross * (history.year?.nontaxableRatio ?? 0), 6));
  if (consume && history.year) {
    history.basis = round(Math.max(0, history.basis - nontaxable), 6);
    history.year[conversion ? 'conversions' : 'distributions'] += gross;
    history.year.basisUsed += nontaxable;
    if (conversion) history.year.nontaxableConversions += nontaxable;
  }
  return { taxable: round(gross - nontaxable, 6), nontaxable };
}
export function iraYearSummary(portfolio) {
  const ledger = ensureIraLedger(portfolio);
  return Object.fromEntries(['primary', 'spouse'].map(owner => {
    const year = ledger[owner].year ?? {};
    return [owner, { ...year, closingBasis: ledger[owner].basis,
      yearEndValue: Math.max(0, (year.denominator ?? 0) - (year.distributions ?? 0) - (year.conversions ?? 0)),
      taxableConversions: round((year.conversions ?? 0) - (year.nontaxableConversions ?? 0), 6) }];
  }));
}

export function remainingIraBasisByAsset(portfolio) {
  const result = new Map();
  const ledger = portfolio.iraLedger;
  if (!ledger) return result;
  for (const owner of ['primary','spouse']) {
    const assets = portfolio.filter(asset => isTraditionalIra(asset) && (ledger.ownerAliases[ownerOf(asset)] ?? ownerOf(asset)) === owner);
    const total = assets.reduce((sum,asset)=>sum+valueOf(asset),0);
    const basis = Math.min(total,ledger[owner].basis);
    for (const asset of assets) result.set(asset, total > 0 ? basis * valueOf(asset) / total : 0);
  }
  return result;
}
