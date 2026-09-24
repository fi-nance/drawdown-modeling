import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { calculateQuarterlyTax, validateQuarterlyTax, federalEstimatedTaxLiability } from '../src/core/quarterlyTax.mjs';
import { parseMonarchPortfolio } from '../src/core/monarchImport.mjs';
import { simulatePlan } from '../src/core/simulation.mjs';
import { createSetupBackup,parseSetupBackup } from '../src/core/setupBackup.mjs';
import { quarterlyTaxHtml,quarterlyPreview } from '../src/quarterlyTaxUI.mjs';

const payload=()=>JSON.parse(readFileSync(new URL('./fixtures/monarch-quarterly.json',import.meta.url),'utf8'));
const cases=JSON.parse(readFileSync(new URL('./fixtures/quarterly-cases.json',import.meta.url),'utf8'));
const parse=data=>parseMonarchPortfolio(JSON.stringify(data),{today:'2026-09-23'});

test('federal regular-installment results agree with Python across all fixture edge cases',()=>{
  for(const {plan,expected} of cases) assert.deepEqual(calculateQuarterlyTax(plan),expected);
});
test('current sibling Python exporter still agrees with browser contract when installed',()=>{
  // This path is optional outside the paired local projects; checked-in fixtures always run.
  const actualPath=new URL('../../monarch-sheets/',import.meta.url);
  if(!existsSync(new URL('tests/test_quarterly.py',actualPath))) return;
  const source=execFileSync('python3',['-c',"import sys,json;sys.path.insert(0,'tests');from test_quarterly import plan_fixture;from monarch_sheets.quarterly import calculate;p=plan_fixture();print(json.dumps({'plan':p,'expected':calculate(p)}))"],{cwd:actualPath,encoding:'utf8'});
  const {plan,expected}=JSON.parse(source);assert.deepEqual(calculateQuarterlyTax(plan),expected);
});
test('reviewed nested handoff validates without changing portfolio amounts',()=>{
  const p=payload(),bundle=parse(p);
  assert.equal(bundle.provenance.yearToDate.quarterlyTax.payments.length,5);
  const legacy=structuredClone(p);delete legacy.yearToDate.quarterlyTax;
  assert.deepEqual(bundle.assets,parse(legacy).assets);
  assert.equal(bundle.provenance.yearToDate.household.federalTaxPaid,8000);
});
test('tampering, ambiguous payments, missing reviews and mismatched YTD totals reject imports',()=>{
  for(const mutate of [q=>q.payments.push({...q.payments[0]}),q=>q.payments[0].amount=-1,
    q=>q.payments[0].date='2026-11-01',q=>q.payments[0].date='2026-02-30',q=>q.payments[0].status='Planned',
    q=>q.payments[0].jurisdiction='Local',q=>q.payments[0].kind='Refund',q=>q.payments[0].amount=5999,
    q=>q.payments[4].amount=800,q=>q.coverageReviewed=false,q=>q.regularInstallmentsReviewed=false,
    q=>q.remainingWithholding=null,q=>q.projectedFederalTax='20000',q=>q.taxYear=2027,q=>q.through='2026-09-21',
    q=>q.priorYearTax=0,q=>q.priorYearMethod='guess',q=>q.payments[3].kind='Withholding']) {
    const p=payload();mutate(p.yearToDate.quarterlyTax);assert.throws(()=>parse(p));
  }
});
test('federal liability includes SE, NIIT and distribution taxes but excludes state and regular FICA',()=>{
  assert.equal(federalEstimatedTaxLiability({totalTax:15000,employeePayrollTax:3000,spouseEmployeePayrollTax:1000,stateTax:2000,penaltyTax:500}),9000);
  assert.equal(federalEstimatedTaxLiability({totalTax:-1}),0);
  assert.throws(()=>federalEstimatedTaxLiability({totalTax:NaN}));
});
const flat={filingStatus:'single',standardDeduction:0,capitalLossOrdinaryIncomeOffset:3000,
  ordinaryBrackets:[{upTo:Infinity,rate:.1}],capitalGainsBrackets:[{upTo:Infinity,rate:.15}],
  state:{standardDeduction:0,brackets:[{upTo:Infinity,rate:0}],treatCapitalGainsAsOrdinary:true}};
function run(source,scenario={}) {
  return simulatePlan({assets:[{id:'fictional-cash',name:'Example cash',accountType:'taxable',assetClass:'cash',units:100000,price:1,costBasisPerUnit:1}],taxProfile:flat,
    scenario:{startYear:2026,currentAge:50,spouseAge:null,planYears:2,targetSpend:0,filingStatus:'single',portfolioImport:source,
      aca:{enabled:false},medicare:{enabled:false},targetSpendIncludesMedical:true,socialSecurityAnnualBenefit:0,
      taxLossHarvesting:{enabled:false},taxGainHarvesting:{enabled:false},rothConversion:{enabled:false},...scenario},
    returnSequence:[{default:0},{default:0}],inflationSequence:[0,0]});
}
test('simulation recalculates targets from full-year federal model; timing does not spend tax twice',()=>{
  const source=parse(payload()).provenance;
  source.yearToDate.household.otherOrdinaryIncome=150000;
  const legacy=structuredClone(source);delete legacy.yearToDate.quarterlyTax;
  const actual=run(source),control=run(legacy);
  const first=actual.years[0];
  assert.equal(first.quarterlyTax.projectedFederalTax,federalEstimatedTaxLiability(first.taxes));
  assert.notEqual(first.quarterlyTax.projectedFederalTax,20000);
  assert.equal(first.endingPortfolioValue,control.years[0].endingPortfolioValue);
  assert.equal(first.taxes.totalTax,control.years[0].taxes.totalTax);
  assert.equal(first.yearToDate.taxPaid,8900);
  assert.equal(actual.years[1].quarterlyTax,undefined);
  assert.throws(()=>run(source,{filingStatus:'marriedFilingJointly'}),/filing status/);
  source.yearToDateEnabled=false;assert.equal(run(source).years[0].quarterlyTax,undefined);
});
test('saved setups retain quarterly inputs and strict reviews on reimport',()=>{
  const source=parse(payload()).provenance;
  const backup=createSetupBackup({assets:[],controls:{},portfolioImport:source});
  assert.deepEqual(parseSetupBackup(JSON.stringify(backup)).portfolioImport.yearToDate.quarterlyTax,source.yearToDate.quarterlyTax);
});
test('quarterly UI escapes imported strings and clearly separates plans from paid amounts',()=>{
  const p=calculateQuarterlyTax(cases[0].plan);p.basis='<img src=x onerror=evil()>';
  const html=quarterlyTaxHtml(p);assert.ok(!html.includes('<img'));assert.match(html,/&lt;img/);
  for(const text of ['Recorded coverage','Forecast coverage','9500','State/local','Schedule AI','not debit']) {
    if(text==='9500') assert.match(html,/9,500/);else assert.ok(html.includes(text),text);
  }
  assert.match(quarterlyPreview(cases[0].plan),/not treated as paid/);
  assert.equal(quarterlyTaxHtml(null),'');
});
