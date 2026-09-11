import { round } from '../utils.mjs';
import { socialSecurityBirthYear, socialSecurityClaimFactor, socialSecurityFullRetirementAge } from './socialSecurity.mjs';

// SSA 2026 annual retirement earnings-test limits. Future limits use the plan's
// inflation assumption; this is a projection, not a future SSA announcement.
export function socialSecurityEarningsForYear({ scenario, owner = 'primary', age, annualBenefit, earnedIncome,
  yearIndex, inflationIndex = 1, creditedMonths = 0, survivor = false }) {
  const birthYear = socialSecurityBirthYear(scenario, owner);
  const fra = socialSecurityFullRetirementAge(birthYear); // retirement FRA also governs survivor earnings test
  const startAge = Number((owner === 'spouse' ? scenario.spouseSocialSecurityStartAge : scenario.socialSecurityStartAge) ?? 67);
  const maxCredits = Math.max(0, Math.round((fra - startAge) * 12));
  const credits = Math.min(maxCredits, Math.max(0, creditedMonths));
  const monthsBeforeFra = Math.max(0, Math.min(12, Math.ceil((fra - age) * 12 - 1e-8)));
  const firstYear = age <= startAge && startAge < age + 1;
  const explicitClaimMonth = Number(owner === 'spouse' ? scenario.spouseSocialSecurityClaimMonth : scenario.socialSecurityClaimMonth) || 1;
  const firstMonth = firstYear ? Math.max(1, Math.min(12, Math.max(explicitClaimMonth, Math.ceil((startAge - age) * 12) + 1))) : 1;
  const payableMonths = Math.max(0, 13 - firstMonth);
  const adjustment = !survivor && credits > 0 ? socialSecurityClaimFactor(startAge + credits / 12, birthYear) / socialSecurityClaimFactor(startAge, birthYear) : 1;
  const afterFraMonths = Math.max(0, 12 - Math.max(monthsBeforeFra, firstMonth - 1));
  let gross = annualBenefit * (payableMonths + afterFraMonths * (adjustment - 1)) / 12;
  if (!(gross > 0) || monthsBeforeFra === 0) return { payable: round(gross, 6), withheld: 0, creditedMonths: credits, method: 'no-earnings-test' };
  const calendarYear = Number(scenario.startYear ?? 2026) + yearIndex;
  const rows = (scenario.socialSecurityWorkCalendar ?? []).filter(row => row.owner === owner && Number(row.year) === calendarYear);
  const completeCalendar = rows.length === 12 && new Set(rows.map(row => row.month)).size === 12
    && Math.abs(rows.reduce((sum, row) => sum + row.earnings, 0) - earnedIncome) < 1;
  const fraYear = monthsBeforeFra < 12;
  const limit = (fraYear ? 65160 : 24480) * inflationIndex;
  const earningsSubject = fraYear
    ? completeCalendar ? rows.filter(row => row.month <= monthsBeforeFra).reduce((sum, row) => sum + row.earnings, 0)
      : earnedIncome // conservative until pre-FRA earnings are supplied
    : earnedIncome;
  const testedBenefit = annualBenefit * Math.max(0, monthsBeforeFra - firstMonth + 1) / 12;
  const annualWithheld = Math.min(testedBenefit, Math.max(0, earningsSubject - limit) / (fraYear ? 3 : 2));
  let withheld = annualWithheld;
  let method = fraYear ? completeCalendar ? 'fra-year-calendar' : 'fra-year-conservative-annual-earnings' : 'annual';
  if (firstYear && completeCalendar) {
    const monthlyLimit = limit / 12;
    const blocked = rows.filter(row => row.month >= firstMonth && row.month <= monthsBeforeFra
      && (row.earnings > monthlyLimit || row.substantialServices));
    const monthlyWithheld = blocked.length * annualBenefit / 12;
    // Special first-year monthly rule can preserve payments in retired months;
    // the annual test still applies when it is more favorable.
    withheld = Math.min(annualWithheld, monthlyWithheld);
    method = 'first-year-monthly';
  }
  const newCredits = survivor ? credits : Math.min(maxCredits, credits + Math.min(payableMonths, Math.ceil(withheld / (annualBenefit / 12) - 1e-8)));
  if (!survivor && afterFraMonths > 0 && newCredits > credits) {
    const updatedAdjustment = socialSecurityClaimFactor(startAge + newCredits / 12, birthYear) / socialSecurityClaimFactor(startAge, birthYear);
    gross += annualBenefit * afterFraMonths * (updatedAdjustment - adjustment) / 12;
  }
  return { payable: round(Math.max(0, gross - withheld), 6), withheld: round(withheld, 6), creditedMonths: newCredits, method,
    earningsLimit: round(limit, 6), earningsSubject: round(earningsSubject, 6), monthsBeforeFra };
}

export function parseSocialSecurityWorkCalendar(text) {
  const seen = new Set();
  if (!String(text ?? '').trim()) return [];
  return String(text).trim().split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    const [owner, yearText, monthText, earningsText, services, ...extra] = line.split(',').map(value => value.trim());
    const year = Number(yearText), month = Number(monthText), earnings = Number(earningsText);
    const key = `${owner}/${year}/${month}`;
    if (extra.length || !['primary','spouse'].includes(owner) || !/^\d{4}$/.test(yearText ?? '') || !Number.isInteger(month) || month < 1 || month > 12 || !earningsText || !Number.isFinite(earnings) || earnings < 0 || !['yes','no'].includes(services) || seen.has(key)) throw new Error(`Social Security work calendar line ${index + 1}: enter owner, year, month, earnings, substantial self-employment services (yes/no); no duplicate months.`);
    seen.add(key); return { owner, year, month, earnings, substantialServices: services === 'yes' };
  });
}
