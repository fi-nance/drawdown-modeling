import { isoDay } from './lotDates.mjs';
import { validateQuarterlyTax } from './quarterlyTax.mjs';

export const YTD_HOUSEHOLD_FIELDS = [
  'taxableWages','medicareWages','socialSecurityWages','spouseTaxableWages','spouseMedicareWages','spouseSocialSecurityWages',
  'selfEmploymentIncome','spouseSelfEmploymentIncome','taxableInterest','stateExemptInterest','otherOrdinaryIncome','socialSecurityBenefits',
  'federalTaxPaid','stateTaxPaid','payrollTaxPaid','remainingTaxableWages','remainingMedicareWages','remainingSocialSecurityWages',
  'remainingSpouseTaxableWages','remainingSpouseMedicareWages','remainingSpouseSocialSecurityWages','remainingSelfEmploymentIncome',
  'remainingSpouseSelfEmploymentIncome','remainingSocialSecurityBenefits','remainingSpending','remainingMedical',
  'remainingQualifiedHsaExpenses','remainingRmdPrimary','remainingRmdSpouse'];
const accountFields=['ordinaryDividends','qualifiedDividends','capitalGainDistributions','returnOfCapital','exemptInterest',
  'shortTermGains','shortTermLosses','longTermGains','longTermLosses','estimatedQualifiedDividends','estimatedSales'];
const fail = message => {throw new Error(`Year-to-date: ${message}`);};
const amount = (v,label) => {
  if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>1e12) fail(`${label} requires a nonnegative amount, including explicit zero.`);
  return v;
};
export function validateYearToDate(data, source) {
  if(!data || data.version!==1 || !Number.isInteger(data.taxYear) || data.through!==source.asOfDate
    || data.taxYear!==isoDay(data.through).getUTCFullYear() || data.reviewedSourceExportedAt!==source.sourceExportedAt
    || source.sourceExportedAt?.slice(0,10)!==data.through) fail('cutoff, source review or version does not match the portfolio.');
  if(data.through.endsWith('-12-31')) fail('use a portfolio-only export for the next year after December 31.');
  for(const key of ['coverageReviewed','estimatesAccepted','unsupportedActivityAbsent','remainingAssumptionsReviewed']) {
    if(data[key]!==true) fail('household coverage, supported activity and remaining assumptions must be explicitly reviewed.');
  }
  const household=Object.fromEntries(YTD_HOUSEHOLD_FIELDS.map(key=>[key,amount(data.household?.[key],key)]));
  if(household.stateExemptInterest>household.taxableInterest) fail('state-exempt interest must be a subset of taxable interest.');
  if(household.remainingQualifiedHsaExpenses>household.remainingMedical) fail('HSA-qualified expenses exceed the healthcare budget.');
  if(!Array.isArray(data.accounts)||data.accounts.length>1000) fail('account activity is missing or too large.');
  const seen=new Set();
  const accounts=data.accounts.map(a=>{
    if(!a || typeof a.accountId!=='string' || !a.accountId || a.accountId.length>2000 || seen.has(a.accountId)
      || typeof a.name!=='string' || a.name.length>2000 || a.currency!=='USD'
      || !['Taxable','Tax-deferred','Roth','HSA'].includes(a.taxBucket)
      || !['primary','spouse','joint'].includes(a.owner) || a.owner==='joint'&&a.taxBucket!=='Taxable') fail('invalid or duplicate activity account.');
    seen.add(a.accountId);
    const portfolioAccount=source.accounts?.find(p=>p.accountId===a.accountId);
    if(portfolioAccount && (portfolioAccount.owner!==a.owner || portfolioAccount.accountType!==
      ({Taxable:'taxable','Tax-deferred':'traditional',Roth:'roth',HSA:'hsa'})[a.taxBucket])) fail('activity classification conflicts with the portfolio account.');
    const row={accountId:a.accountId,name:a.name,currency:a.currency,taxBucket:a.taxBucket,owner:a.owner,
      ...Object.fromEntries(accountFields.map(k=>[k,amount(a[k],k)]))};
    if(row.qualifiedDividends>row.ordinaryDividends+.000001 || row.estimatedQualifiedDividends>row.qualifiedDividends+.000001
      || !Number.isInteger(row.estimatedSales)) fail('dividend qualification or sale estimate count is inconsistent.');
    if(['Taxable','HSA'].includes(row.taxBucket)&&row.exemptInterest!==0) fail('tax-exempt interest is not supported in remaining-year mode yet.');
    return row;
  });
  for(const key of ['dividendRecordCount','saleLotCount']) if(!Number.isInteger(data[key])||data[key]<0||data[key]>1e6) fail('invalid activity count.');
  const quarterlyTax=data.quarterlyTax==null?null:validateQuarterlyTax(data.quarterlyTax,{...data,household});
  return {...data,household,accounts,...(quarterlyTax?{quarterlyTax}:{})};
}

export function yearToDateForScenario(scenario, yearIndex=0) {
  const source=scenario.portfolioImport;
  if(yearIndex!==0 || !source?.yearToDate || source.yearToDateEnabled===false) return null;
  const ytd=validateYearToDate(source.yearToDate,source);
  if(scenario.startYear!==ytd.taxYear) fail('plan start year must match the imported cutoff year.');
  if(ytd.quarterlyTax && scenario.filingStatus && ytd.quarterlyTax.filingStatus!==scenario.filingStatus) fail('quarterly filing status differs from the plan; update and re-export the reviewed inputs.');
  if(scenario.tipsLadder?.enabled) fail('TIPS ladders require a full-year start; disable the ladder or remaining-year mode.');
  return ytd;
}

export function remainingYearFraction(ytd) {
  const start=Date.UTC(ytd.taxYear,0,1), end=Date.UTC(ytd.taxYear+1,0,1);
  return (end-isoDay(ytd.through).getTime()-86400000)/(end-start);
}
export const periodReturn = (annual,fraction) => fraction===1?annual:Math.pow(Math.max(0,1+annual),fraction)-1;

// Earnings have separate cash/taxable/FICA bases. Past earnings enter only incomeForYear.
export function ytdEarnedIncome(h, remaining=false) {
  const v=key=>h[remaining?'remaining'+key[0].toUpperCase()+key.slice(1):key];
  const ordinaryIncome=v('taxableWages')+v('spouseTaxableWages')+v('selfEmploymentIncome')+v('spouseSelfEmploymentIncome');
  return {cash:remaining?ordinaryIncome:0,ordinaryIncome,rrtaCompensation:0,
    ...Object.fromEntries(['medicareWages','socialSecurityWages','spouseMedicareWages','spouseSocialSecurityWages','selfEmploymentIncome','spouseSelfEmploymentIncome'].map(k=>[k,v(k)]))};
}
export function ytdInvestmentTotals(ytd,bucket='Taxable') {
  return (ytd?.accounts??[]).filter(a=>a.taxBucket===bucket).reduce((sum,a)=>{
    for(const key of accountFields) sum[key]+=a[key];return sum;
  },Object.fromEntries(accountFields.map(k=>[k,0])));
}
export function ytdCapitalEvents(ytd,bucket='Taxable') {
  return (ytd?.accounts??[]).filter(a=>a.taxBucket===bucket).flatMap(a=>[
    {owner:a.owner,accountType:'taxable',taxType:'short',gain:a.shortTermGains-a.shortTermLosses},
    {owner:a.owner,accountType:'taxable',taxType:'long',gain:a.longTermGains+a.capitalGainDistributions-a.longTermLosses}
  ]).filter(e=>e.gain!==0);
}

// Credits stay in their tax channel. Never spend an assumed refund or use a state
// overpayment to finance a federal balance. Annual liability remains unmodified.
export function remainingTaxCash(taxes,scenario) {
  const h=scenario.activeYearToDate?.household;
  if(!h) return taxes.totalTax;
  const payroll=(taxes.employeePayrollTax??0)+(taxes.spouseEmployeePayrollTax??0);
  const state=taxes.stateTax??0, penalty=taxes.penaltyTax??0;
  const federal=taxes.totalTax-payroll-state-penalty;
  return Math.max(0,federal-h.federalTaxPaid)+Math.max(0,state-h.stateTaxPaid)+Math.max(0,payroll-h.payrollTaxPaid)+penalty;
}

export function partialYearScenario(scenario,ytd) {
  if(!ytd) return scenario;
  return {...scenario,activeYearToDate:ytd,
    targetSpend:ytd.household.remainingSpending,spendingStrategy:{mode:'fixed'},
    agePhasedSpending:{...scenario.agePhasedSpending,enabled:false},
    targetSpendIncludesMedical:false,targetSpendIncludesTaxes:false,
    aca:{...scenario.aca,enabled:false},
    // Year-one income and medical budgets are explicit. Annual inputs resume in year two.
    medicareWages:0,spouseMedicareWages:0,selfEmploymentIncome:0,spouseSelfEmploymentIncome:0,rrtaCompensation:0};
}
