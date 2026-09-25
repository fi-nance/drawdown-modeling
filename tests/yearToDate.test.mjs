import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_SCENARIO, simulatePlan } from '../src/core/simulation.mjs';
import { runDecisionBatch } from '../src/core/decisionEngine.mjs';
import { YTD_HOUSEHOLD_FIELDS, validateYearToDate, remainingYearFraction, remainingTaxCash, periodReturn } from '../src/core/yearToDate.mjs';
import { parseMonarchPortfolio } from '../src/core/monarchImport.mjs';
import { createSetupBackup, parseSetupBackup } from '../src/core/setupBackup.mjs';

const near=(a,b)=>assert.ok(Math.abs(a-b)<.02,`${a} != ${b}`);
const flat={filingStatus:'single',standardDeduction:0,capitalLossOrdinaryIncomeOffset:3000,
  ordinaryBrackets:[{upTo:Infinity,rate:.1}],capitalGainsBrackets:[{upTo:Infinity,rate:.15}],
  state:{standardDeduction:0,brackets:[{upTo:Infinity,rate:0}],treatCapitalGainsAsOrdinary:true}};
function source() {
  return {asOfDate:'2026-09-22',sourceExportedAt:'2026-09-22T00:00:00Z',yearToDateEnabled:true,
    yearToDate:{version:1,taxYear:2026,through:'2026-09-22',reviewedSourceExportedAt:'2026-09-22T00:00:00Z',
      coverageReviewed:true,estimatesAccepted:true,unsupportedActivityAbsent:true,remainingAssumptionsReviewed:true,
      household:Object.fromEntries(YTD_HOUSEHOLD_FIELDS.map(k=>[k,0])),accounts:[],dividendRecordCount:0,saleLotCount:0}};
}
function account(taxBucket='Taxable',values={}) {
  return {accountId:'fictional-'+taxBucket,name:'Example '+taxBucket,taxBucket,currency:'USD',owner:'primary',
    ordinaryDividends:0,qualifiedDividends:0,capitalGainDistributions:0,returnOfCapital:0,exemptInterest:0,
    shortTermGains:0,shortTermLosses:0,longTermGains:0,longTermLosses:0,estimatedQualifiedDividends:0,estimatedSales:0,...values};
}
const cash={id:'fictional-cash',name:'Example cash',accountType:'taxable',assetClass:'cash',units:100000,price:1,costBasisPerUnit:1};
test('YTD decision runs finish without unsupported ladder probes; annual mode retains ladder recommendations',()=>{
  for(const enabled of [true,false]) {
    const portfolioImport=source();portfolioImport.yearToDateEnabled=enabled;
    const decision=runDecisionBatch({assets:[cash],taxProfile:flat,runs:2,seed:42,
      scenario:{...DEFAULT_SCENARIO,startYear:2026,currentAge:50,spouseAge:null,planYears:2,targetSpend:1000,
        portfolioImport,aca:{enabled:false},medicare:{enabled:false},targetSpendIncludesMedical:true,
        socialSecurityAnnualBenefit:0,withdrawalStrategyMode:'heuristic',
        taxLossHarvesting:{enabled:false},taxGainHarvesting:{enabled:false},rothConversion:{enabled:false}}});
    assert.ok(decision.verdict);
    const options=[...decision.rescueOptions,...decision.testedRescueOptions];
    assert.equal(options.some(option=>option.kind==='tipsLadder'),!enabled);
  }
});
function run(s=source(),overrides={},assets=[cash],taxProfile=flat) {
  return simulatePlan({assets,taxProfile,scenario:{startYear:2026,currentAge:50,spouseAge:null,planYears:2,targetSpend:0,
    portfolioImport:s,aca:{enabled:false},medicare:{enabled:false},targetSpendIncludesMedical:true,
    socialSecurityAnnualBenefit:0,taxLossHarvesting:{enabled:false},taxGainHarvesting:{enabled:false},rothConversion:{enabled:false},
    ...overrides},returnSequence:[{default:0},{default:0}],inflationSequence:[0,0]});
}
test('YTD qualified subset, ST/LT gains and distributions tax once without creating cash',()=>{
  const s=source();s.yearToDate.accounts=[account('Taxable',{ordinaryDividends:1000,qualifiedDividends:800,
    shortTermGains:200,longTermGains:300,capitalGainDistributions:100,returnOfCapital:999})];
  const p=run(s,{},[cash],{...flat,ordinaryBrackets:[{upTo:Infinity,rate:.2}]}),first=p.years[0],second=p.years[1];
  near(first.taxes.totalTax,260);near(first.endingPortfolioValue,100000-260);
  near(first.taxableDividendsCash,0);near(first.realizedLongTermGains,400);near(first.realizedShortTermGains,200);
  near(first.yearToDate.remainingTaxCash,260);near(second.taxes.totalTax,0);assert.equal(second.yearToDate,undefined);
});
test('paid taxes reduce cash withdrawals once; excess paid does not create a spendable refund',()=>{
  const s=source();s.yearToDate.household.otherOrdinaryIncome=20000;s.yearToDate.household.federalTaxPaid=1500;
  let p=run(s);near(p.years[0].taxes.totalTax,2000);near(p.years[0].cashRaised,500);near(p.endingValue,99500);
  s.yearToDate.household.federalTaxPaid=2500;p=run(s);
  near(p.years[0].cashRaised,0);near(p.endingValue,100000);near(p.years[0].yearToDate.unspentTaxCredit,500);
  near(remainingTaxCash({totalTax:2200,stateTax:200,employeePayrollTax:0}, {activeYearToDate:s.yearToDate}),200);
});
test('explicit remaining spending and medical replace annual budgets only in year one',()=>{
  const s=source();Object.assign(s.yearToDate.household,{remainingSpending:1000,remainingMedical:200});
  const p=run(s,{targetSpend:10000,spendingStrategy:{mode:'discretionaryGuardrails',essentialSpend:9000,discretionarySpend:1000}});
  near(p.years[0].plannedSpending,1000);near(p.years[0].totalCashRequired,1200);near(p.years[1].plannedSpending,10000);
});
test('past and remaining wages use separate taxable and payroll bases, with future cash only',()=>{
  const s=source(),h=s.yearToDate.household;
  Object.assign(h,{taxableWages:40000,medicareWages:50000,socialSecurityWages:50000,remainingTaxableWages:8000,
    remainingMedicareWages:10000,remainingSocialSecurityWages:10000,federalTaxPaid:4000,payrollTaxPaid:3825});
  const p=run(s,{medicareWages:12000},[cash],{...flat,employeePayrollTax:{socialSecurityRate:.062,medicareRate:.0145,socialSecurityWageBase:184500}});
  near(p.years[0].taxes.employeePayrollTax,4590);near(p.years[0].taxes.federalIncomeTax,4800);
  near(p.years[0].cashAvailable,8000);near(p.years[0].yearToDate.remainingTaxCash,1565);
  near(p.years[0].endingPortfolioValue,106435);near(p.years[1].earnedIncome,12000);
});
test('sheltered trading is not federal income; HSA capital events remain available to state carryovers',()=>{
  const s=source();s.yearToDate.accounts=['Tax-deferred','Roth','HSA'].map(k=>account(k,{ordinaryDividends:1000,longTermGains:2000}));
  const y=run(s).years[0];near(y.taxes.totalTax,0);near(y.endingPortfolioValue,100000);
  assert.deepEqual(y.stateHsaCapitalEvents,[{owner:'primary',accountType:'taxable',taxType:'long',gain:2000}]);
});
test('loss character and owner survive year-one netting without replaying past sales',()=>{
  const s=source();s.yearToDate.accounts=[account('Taxable',{shortTermLosses:8000,owner:'spouse'})];
  const p=run(s,{spouseAge:50});near(p.years[0].realizedCapitalLosses,8000);near(p.years[1].realizedCapitalLosses,0);
  near(p.years[0].lossCarryforward,8000);near(p.endingValue,100000);
});
test('partial returns and future dividends use day fraction; next year returns to full-year yield',()=>{
  const s=source(),fraction=100/365;near(remainingYearFraction(s.yearToDate),fraction);
  const stock={...cash,id:'stock',assetClass:'stock',units:1000,price:100,costBasisPerUnit:100,dividendYield:.04,qualifiedDividendShare:0};
  const p=run(s,{},[stock],{...flat,ordinaryBrackets:[{upTo:Infinity,rate:0}]});
  near(p.years[0].taxableDividendsCash,4000*fraction);
  near(p.years[1].taxableDividendsCash,stock.units*(100-4*fraction)*.04);
  near(p.years[0].endingPortfolioValue,100000);near(periodReturn(.1,fraction),Math.pow(1.1,fraction)-1);
});
test('legacy/disabled mode stays annual and invalid or wrong-year history fails closed',()=>{
  const s=source();s.yearToDateEnabled=false;near(run(s,{targetSpend:1000}).years[0].plannedSpending,1000);
  s.yearToDateEnabled=true;assert.throws(()=>run(s,{startYear:2027}),/start year/);
  assert.throws(()=>run(s,{tipsLadder:{enabled:true}}),/TIPS/);
  delete s.yearToDate.household.taxableInterest;assert.throws(()=>run(s),/explicit zero/);
});
test('cutoff uses leap-year days; source mismatch, duplicates and missing review are rejected',()=>{
  const s=source();s.asOfDate='2024-02-29';s.sourceExportedAt='2024-02-29T00:00:00Z';
  Object.assign(s.yearToDate,{through:s.asOfDate,taxYear:2024,reviewedSourceExportedAt:s.sourceExportedAt});
  near(remainingYearFraction(validateYearToDate(s.yearToDate,s)),306/366);
  s.yearToDate.accounts=[account(),account()];assert.throws(()=>validateYearToDate(s.yearToDate,s),/duplicate/);
  s.yearToDate.accounts=[];s.yearToDate.coverageReviewed=false;assert.throws(()=>validateYearToDate(s.yearToDate,s),/review/);
});
test('fictional Python contract fixture parses and persists without changing provenance',()=>{
  const raw=readFileSync(new URL('./fixtures/monarch-ytd.json',import.meta.url),'utf8');
  const bundle=parseMonarchPortfolio(raw,{today:'2026-09-22'});
  assert.equal(bundle.provenance.yearToDate.accounts[0].qualifiedDividends,9.872);
  const backup=parseSetupBackup(JSON.stringify(createSetupBackup({assets:bundle.assets,controls:{},portfolioImport:bundle.provenance})));
  assert.deepEqual(backup.portfolioImport,bundle.provenance);
});
test('live Python-to-JavaScript fictional contract when the sibling exporter is installed',
  {skip:!existsSync(new URL('../../monarch-sheets/tests/test_drawdown_ytd.py',import.meta.url))},()=>{
  const script="import sys,json; sys.path.insert(0,'tests'); from test_drawdown_ytd import fixture,run; r=run(fixture()); assert not r['issues'],r['issues']; print(json.dumps(r['payload']))";
  const raw=execFileSync('python3',['-c',script],{cwd:new URL('../../monarch-sheets/',import.meta.url),encoding:'utf8'});
  const bundle=parseMonarchPortfolio(raw,{today:'2026-09-22'});
  assert.equal(bundle.provenance.yearToDate.accounts[0].qualifiedDividends,9.872);
  const backup=parseSetupBackup(JSON.stringify(createSetupBackup({assets:bundle.assets,controls:{},portfolioImport:bundle.provenance})));
  assert.deepEqual(backup.portfolioImport,bundle.provenance);
});
test('YTD Social Security affects annual taxable benefits without adding past benefits to cash',()=>{
  const s=source();Object.assign(s.yearToDate.household,{socialSecurityBenefits:20000,otherOrdinaryIncome:50000,remainingSocialSecurityBenefits:1000});
  const p=run(s);near(p.years[0].taxableSocialSecurity,17850);near(p.years[0].cashAvailable,6785);
  near(p.years[0].taxes.totalTax,6785);near(p.years[0].endingPortfolioValue,94215);
});
test('reviewed remaining RMD replaces the annual as-of balance estimate only in first year',()=>{
  const s=source();s.yearToDate.household.remainingRmdPrimary=500;
  const p=run(s,{currentAge:75},[{...cash,accountType:'traditional',accountSubtype:'traditionalIra'}]);
  near(p.years[0].rmdAmount,500);near(p.years[0].taxes.totalTax,50);
  assert.ok(p.years[1].rmdAmount>3000);
});
test('HSA YTD income and capital-gain distributions affect nonconforming state tax only',()=>{
  const s=source();s.yearToDate.accounts=[account('HSA',{ordinaryDividends:1000,longTermGains:2000,capitalGainDistributions:300})];
  const p=run(s,{},[cash],{...flat,state:{...flat.state,state:'California',brackets:[{upTo:Infinity,rate:.05}]}});
  near(p.years[0].taxes.federalIncomeTax,0);near(p.years[0].taxes.stateTax,165);near(p.years[1].taxes.stateTax,0);
});
