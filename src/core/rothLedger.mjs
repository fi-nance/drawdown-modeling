import { round } from './utils.mjs';

// IRS Publication 590-B: aggregate Roth IRA distributions for EACH taxpayer.
// Security cost basis is not IRA tax basis. This ledger follows the portfolio
// through clones, while securities may be exchanged without changing history.
const dollars = value => Math.max(0, Number(value) || 0);
const ownerKey = value => value === 'spouse' ? 'spouse' : 'primary';
const emptyOwner = contributions => ({ contributions: dollars(contributions), conversions: [] });

export function attachRothLedger(portfolio, ledger) {
  Object.defineProperty(portfolio, 'rothLedger', { value: ledger, writable: true, configurable: true, enumerable: false });
  return ledger;
}

export function copyRothLedger(target, source) {
  if (source.rothLedger) {
    const ledger = source.rothLedger;
    attachRothLedger(target, {
      primary: { contributions: ledger.primary.contributions, conversions: ledger.primary.conversions.map(entry => ({ ...entry })) },
      spouse: { contributions: ledger.spouse.contributions, conversions: ledger.spouse.conversions.map(entry => ({ ...entry })) },
      ownerAliases: { ...ledger.ownerAliases }
    });
  }
  return target;
}

export function ensureRothLedger(portfolio, options = {}) {
  if (portfolio.rothLedger) return portfolio.rothLedger;
  const ledger = {
    primary: emptyOwner(options.rothBasis ?? options.rothBasisRemaining),
    spouse: emptyOwner(options.spouseRothBasis),
    ownerAliases: {}
  };
  attachRothLedger(portfolio, ledger);
  const history = options.rothConversionHistory;
  if (Array.isArray(history)) {
    for (const entry of history) recordRothConversion(portfolio, entry.owner, entry.year, entry.taxableAmount, entry.nontaxableAmount);
  } else {
    // Legacy import only: capture remaining conversion principal once, BEFORE
    // returns, dividends, or trades. Explicit history takes precedence.
    for (const asset of portfolio) {
      if (asset.accountType === 'roth' && asset.rothSource === 'conversion') {
        recordRothConversion(portfolio, asset.owner, asset.conversionYear, dollars(asset.units) * dollars(asset.costBasisPerUnit));
      }
    }
  }
  return ledger;
}

export function recordRothConversion(portfolio, owner, year, taxableAmount, nontaxableAmount = 0) {
  const ledger = ensureRothLedger(portfolio);
  const key = ledger.ownerAliases[ownerKey(owner)] ?? ownerKey(owner);
  const conversions = ledger[key].conversions;
  // Unknown dates are conservatively unseasoned until corrected by the user.
  const normalizedYear = Number.isFinite(Number(year)) && year != null ? Number(year) : null;
  let entry = conversions.find(item => item.year === normalizedYear);
  if (!entry) conversions.push(entry = { year: normalizedYear, taxableAmount: 0, nontaxableAmount: 0 });
  entry.taxableAmount = round(entry.taxableAmount + dollars(taxableAmount), 6);
  entry.nontaxableAmount = round(entry.nontaxableAmount + dollars(nontaxableAmount), 6);
  conversions.sort((a, b) => (a.year ?? Infinity) - (b.year ?? Infinity));
}

export function rothContributionBalance(ledger) {
  return round(ledger.primary.contributions + ledger.spouse.contributions, 6);
}

export function consumeRothDistribution(ledger, owner, amount, { calendarYear, isEarly, qualified }) {
  const key = ledger.ownerAliases[ownerKey(owner)] ?? ownerKey(owner);
  const history = ledger[key];
  const contributions = Math.min(dollars(amount), history.contributions);
  history.contributions = round(history.contributions - contributions, 6);
  let remaining = dollars(amount) - contributions;
  let conversionPrincipal = 0;
  let recaptureBase = 0;
  for (const entry of history.conversions) {
    // Taxable conversions precede nontaxable conversions within each year.
    for (const field of ['taxableAmount', 'nontaxableAmount']) {
      const used = Math.min(remaining, entry[field]);
      entry[field] = round(entry[field] - used, 6);
      remaining = round(remaining - used, 6);
      conversionPrincipal += used;
      if (field === 'taxableAmount' && isEarly && (entry.year == null || calendarYear - entry.year < 5)) recaptureBase += used;
    }
  }
  return {
    contributions, conversionPrincipal: round(conversionPrincipal, 6),
    earnings: qualified ? 0 : Math.max(0, remaining),
    penaltyBase: qualified ? 0 : round(recaptureBase + (isEarly ? Math.max(0, remaining) : 0), 6)
  };
}

export function rolloverRothLedger(portfolio, deceasedOwner) {
  const ledger = ensureRothLedger(portfolio);
  if (ledger.ownerAliases[deceasedOwner]) return;
  const survivor = deceasedOwner === 'spouse' ? 'primary' : 'spouse';
  ledger[survivor].contributions += ledger[deceasedOwner].contributions;
  for (const entry of [...ledger[deceasedOwner].conversions]) recordRothConversion(portfolio, survivor, entry.year, entry.taxableAmount, entry.nontaxableAmount);
  ledger[deceasedOwner] = emptyOwner(0);
  ledger.ownerAliases[deceasedOwner] = survivor;
}

export function rothLedgerSummary(portfolio, options) {
  const ledger = ensureRothLedger(portfolio, options);
  let conversionPrincipal = 0;
  let penaltyFreeConversionPrincipal = 0;
  let available = 0;
  const ownerAvailable = {};
  for (const owner of ['primary', 'spouse']) {
    if (ledger.ownerAliases[owner]) continue;
    const history = ledger[owner];
    const age = Number(options.ownerAges?.[owner] ?? options.age);
    const early = age < Number(options.penaltyAge ?? 59.5);
    let safe = history.contributions;
    let blocked = false;
    for (const entry of history.conversions) {
      conversionPrincipal += entry.taxableAmount + entry.nontaxableAmount;
      const seasoned = !early || (entry.year != null && options.calendarYear - entry.year >= 5);
      if (!seasoned && entry.taxableAmount > 0) blocked = true;
      if (!blocked) {
        penaltyFreeConversionPrincipal += entry.taxableAmount + entry.nontaxableAmount;
        safe += entry.taxableAmount + entry.nontaxableAmount;
      }
    }
    const value = portfolio.reduce((sum, asset) => sum + (asset.accountType === 'roth' && (ledger.ownerAliases[ownerKey(asset.owner)] ?? ownerKey(asset.owner)) === owner ? dollars(asset.units) * dollars(asset.price) : 0), 0);
    const fiveYears = Object.keys(ledger.ownerAliases).length ? options.rothFiveYearRuleSatisfied !== false || (options.spouseRothFiveYearRuleSatisfied ?? options.rothFiveYearRuleSatisfied) !== false : owner === 'spouse' ? options.spouseRothFiveYearRuleSatisfied ?? options.rothFiveYearRuleSatisfied : options.rothFiveYearRuleSatisfied;
    ownerAvailable[owner] = Math.min(value, !early && fiveYears !== false ? value : safe);
    available += ownerAvailable[owner];
  }
  return { conversionPrincipal: round(conversionPrincipal, 6), penaltyFreeConversionPrincipal: round(penaltyFreeConversionPrincipal, 6), available: round(available, 6), ownerAvailable };
}

// Advanced setup accepts one remaining conversion per line, e.g.
// primary, 2020, 100000, 0. Values are remaining amounts after past distributions.
export function parseRothConversionHistory(text) {
  if (!String(text ?? '').trim()) return [];
  return String(text).trim().split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    const fields = line.split(',').map(field => field.trim());
    const [owner, yearText, taxableText, nontaxableText = '0'] = fields;
    const year = Number(yearText);
    const taxableAmount = Number(taxableText);
    const nontaxableAmount = Number(nontaxableText);
    if (fields.length < 3 || fields.length > 4 || !['primary', 'spouse'].includes(owner) || !/^\d{4}$/.test(yearText) || year < 1998 || !taxableText || !nontaxableText || !Number.isFinite(taxableAmount) || !Number.isFinite(nontaxableAmount) || taxableAmount < 0 || nontaxableAmount < 0) {
      throw new Error(`Roth conversion history line ${index + 1}: enter primary or spouse, year, remaining taxable amount, remaining nontaxable amount. Use numbers without thousands separators.`);
    }
    return { owner, year, taxableAmount, nontaxableAmount };
  });
}
