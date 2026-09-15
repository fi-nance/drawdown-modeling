import test from 'node:test';
import assert from 'node:assert/strict';
import { simulatePlan, DEFAULT_SCENARIO } from '../src/core/simulation.mjs';
import { buildTaxProfile } from '../src/data/taxData.mjs';
import { ensureIraLedger, beginIraTaxYear, iraYearSummary, prepareRetirementAccounts, rolloverIraLedger } from '../src/core/iraBasis.mjs';
import { clonePortfolio } from '../src/core/portfolio.mjs';
import { convertTraditionalToRoth, conversionTaxableAmount, conversionGrossForTaxableLimit, withdrawForCash } from '../src/core/simulation/withdrawalExecution.mjs';
import { parsePortfolioCsv, parsePortfolioJson } from '../src/core/importers.mjs';
import { computeAca, inflateAcaConfig } from '../src/core/aca.mjs';
import { medicalCostForYear } from '../src/core/simulation/medical.mjs';
import { advanceLossLedger } from '../src/core/capitalLossLedger.mjs';
import { estimateHeirValueBreakdown } from '../src/core/simulation/heirEstate.mjs';
import { socialSecurityClaimFactor } from '../src/core/simulation/socialSecurity.mjs';
import { ensureRothLedger, consumeRothDistribution, rothLedgerSummary } from '../src/core/rothLedger.mjs';
import { rothConversionAmountForYear } from '../src/core/simulation/taxStrategy.mjs';
import { applyPlanningExtensionControls, planningExtensionControlsForScenario } from '../src/core/planningExtensions.mjs';

const close = (actual,expected,tolerance=0.01) => assert.ok(Math.abs(actual-expected)<tolerance,`${actual} != ${expected}`);
const lot = (id,value,extra={}) => ({id,name:id,accountType:'traditional',assetClass:'cash',units:value,price:1,costBasisPerUnit:1,...extra});
const returns = Object.fromEntries(['cash','stock','bond','inflation','medicalInflation'].map(key=>[key,{mean:0,stdev:0}]));
const scenario = {...DEFAULT_SCENARIO,startYear:2026,currentAge:60,spouseAge:null,planYears:1,targetSpend:1000,requiredSpendingFloor:1000,
  returnAssumptions:returns,aca:{enabled:false},medicare:{premiumsEnabled:false},rothConversion:{enabled:false},taxLossHarvesting:{enabled:false},taxGainHarvesting:{enabled:false}};
const profile = buildTaxProfile({filingStatus:'single',state:'Florida'});
const jointProfile = buildTaxProfile({filingStatus:'marriedFilingJointly',state:'Florida'});
test('an undated Roth ledger does not override a later explicit unqualified distribution context', () => {
  const assets=[lot('roth',10000,{accountType:'roth'})];
  const ledger=ensureRothLedger(assets);
  const sale=consumeRothDistribution(ledger,'primary',1000,{calendarYear:2026,isEarly:false,qualified:false});
  assert.equal(sale.earnings,1000);
});
const setupIras = (assets,basis=25000,spouseBasis=0) => {
  ensureIraLedger(assets,{traditionalIraBasis:basis,spouseTraditionalIraBasis:spouseBasis}); beginIraTaxYear(assets); return assets;
};

test('Form 8606 aggregates other traditional, SEP and SIMPLE IRAs but excludes spouse and employer plans',()=>{
  const p=setupIras([lot('conversion',100000),lot('other',300000),lot('sep',300000,{accountSubtype:'sepIra'}),lot('simple',300000,{accountSubtype:'simpleIra'}),lot('401k',500000,{accountSubtype:'401k'}),lot('spouse',200000,{owner:'spouse'})],25000,100000);
  assert.equal(conversionTaxableAmount(p,100000),97500);
  assert.equal(conversionGrossForTaxableLimit(p,97500),100000);
  convertTraditionalToRoth(p,100000,2026);
  const audit=iraYearSummary(p);
  assert.equal(audit.primary.denominator,1000000); assert.equal(audit.primary.closingBasis,22500);
  assert.equal(audit.spouse.closingBasis,100000);
  assert.deepEqual(p.rothLedger.primary.conversions,[{year:2026,taxableAmount:97500,nontaxableAmount:2500}]);
});
test('IRA withdrawals and conversions share one annual basis fraction; penalties exclude returned basis',()=>{
  const p=setupIras([lot('ira',100000)],25000);
  const first=withdrawForCash(p,20000,['traditional'],{age:50,calendarYear:2026});
  assert.equal(first.ordinaryIncome,15000); assert.equal(first.penaltyTax,1500);
  convertTraditionalToRoth(p,20000,2026);
  assert.equal(iraYearSummary(p).primary.closingBasis,15000);
  beginIraTaxYear(p); convertTraditionalToRoth(p,60000,2027);
  assert.equal(iraYearSummary(p).primary.closingBasis,0);
});
test('IRA basis survives clones without trial conversions consuming the source ledger',()=>{
  const p=setupIras([lot('ira',100000)],100000), candidate=clonePortfolio(p);
  assert.equal(conversionGrossForTaxableLimit(candidate,0),100000);
  convertTraditionalToRoth(candidate,100000,2026);
  assert.equal(p.iraLedger.primary.basis,100000); assert.equal(candidate.iraLedger.primary.basis,0);
  assert.equal(candidate.rothLedger.primary.conversions[0].taxableAmount,0);
});
test('IRA imported basis survives CSV and JSON; repeated account totals are counted once',()=>{
  const csv='id,name,accountType,assetClass,units,price,costBasisPerUnit,accountId,nondeductibleBasis\na,IRA,traditional,cash,50000,1,1,one,25000\nb,IRA,traditional,cash,50000,1,1,one,25000';
  for(const p of [parsePortfolioCsv(csv),parsePortfolioJson(JSON.stringify(parsePortfolioCsv(csv)))]) {
    ensureIraLedger(p); beginIraTaxYear(p); assert.equal(p.iraLedger.primary.basis,25000);
    assert.equal(conversionTaxableAmount(p,10000),7500);
  }
  assert.throws(()=>ensureIraLedger(parsePortfolioCsv(csv),{traditionalIraBasis:24000}),/disagree/);
  assert.throws(()=>parsePortfolioJson(JSON.stringify([lot('ira',10000,{nondeductibleBasis:-1})])),/basis/);
});
test('basis follows spousal IRA rollover and reduces the existing inherited-income tax estimate',()=>{
  const p=setupIras([lot('one',100000),lot('two',100000,{owner:'spouse'})],25000,50000);
  rolloverIraLedger(p,'primary'); beginIraTaxYear(p);
  assert.equal(p.iraLedger.spouse.basis,75000);
  close(estimateHeirValueBreakdown(p,0.24,{heirType:'nonSpouse10Yr',taxProfile:{ordinaryBrackets:[{upTo:Infinity,rate:0.24}],standardDeduction:0}}).traditionalIncomeTaxEstimate,30000);
});
test('end-to-end conversion cash, taxable income, MAGI and remaining basis reconcile',()=>{
  const result=simulatePlan({assets:[lot('ira',100000),lot('other',900000),lot('cash',100000,{accountType:'taxable'})],taxProfile:profile,
    scenario:{...scenario,traditionalIraBasis:25000,rothConversion:{enabled:true,overrideAmount:100000,magiBuffer:0,applyMagiGuardrails:false}}});
  const year=result.years[0];
  assert.equal(year.rothConversionAmount,100000);assert.equal(year.rothConversionTaxableAmount,97500);
  assert.equal(year.rothConversionNontaxableAmount,2500);assert.equal(year.acaMagi,97500);
  assert.equal(year.iraBasis.primary.closingBasis,22500);
});
test('IRA annual ratio includes investment growth and RMDs consume basis',()=>{
  const result=simulatePlan({assets:[lot('ira',100000,{assetClass:'stock'}),lot('cash',100000,{accountType:'taxable'})],taxProfile:profile,
    returnSequence:[{stock:0.1,cash:0}],scenario:{...scenario,currentAge:75,traditionalIraBasis:25000}});
  const year=result.years[0];
  close(year.iraBasis.primary.denominator,110000);assert.ok(year.rmdAmount>0);
  close(year.iraBasis.primary.basisUsed,year.rmdAmount*25000/110000);
});
test('designated Roth accounts require an explicit completed IRA rollover',()=>{
  const asset=lot('rothPlan',100000,{accountType:'roth',accountSubtype:'roth401k'});
  assert.throws(()=>prepareRetirementAccounts([asset]),/completed rollover/);
  assert.equal(prepareRetirementAccounts([{...asset,rolloverToIraAtStart:true}])[0].accountSubtype,'rothIra');
  const distribution=withdrawForCash([lot('457',10000,{accountSubtype:'governmental457b'})],1000,['traditional'],{age:50});
  assert.equal(distribution.penaltyTax,0);assert.equal(distribution.ordinaryIncome,1000);
});

const csr={enabled:true,standard:{oopMaximum:10000,expectedOop:5000},silver94:{oopMaximum:3000,expectedOop:300},silver87:{oopMaximum:3500,expectedOop:800},silver73:{oopMaximum:8000,expectedOop:3500}};
const acaConfig={enabled:true,fpl:20000,ptcEligibility:'eligible',benchmarkPremium:12000,selectedPlanPremium:12000,oopMaximum:10000,csr};
test('CSR exact income boundaries select 94, 87, 73 and standard Silver costs',()=>{
  for(const [magi,band] of [[19999,'standard'],[20000,'silver94'],[30000,'silver94'],[30000.001,'silver87'],[40000,'silver87'],[40000.001,'silver73'],[50000,'silver73'],[50000.001,'standard']]) assert.equal(computeAca({magi,config:acaConfig}).costSharing.band,band);
});
test('CSR requires confirmed eligibility and Silver; backup and Medicare do not inherit reductions',()=>{
  assert.equal(computeAca({magi:25000,config:{...acaConfig,ptcEligibility:'unknown'}}).costSharing.band,'standard');
  assert.equal(computeAca({magi:25000,config:{...acaConfig,ptcAllowedByFiling:false}}).costSharing.band,'standard');
  assert.equal(computeAca({magi:25000,config:{...acaConfig,csr:{enabled:false}}}).costSharing,undefined);
  assert.equal(computeAca({magi:25000,config:{...acaConfig,enabled:false}}).costSharing,undefined);
  assert.equal(computeAca({magi:60000,config:{...acaConfig,backupPlan:{enabled:true,triggerFplPercent:250,selectedPlanPremium:10000,oopMaximum:8000}}}).costSharing,undefined);
});
test('CSR affects medical cash costs, respects medical inflation, and is not double-counted',()=>{
  const config=inflateAcaConfig(acaConfig,1,{},1.1);
  const aca=computeAca({magi:25000,config});
  assert.equal(aca.costSharing.expectedOop,330);
  const costs=medicalCostForYear({scenario:{...scenario,medicalExpensesBase:1000,expectedOopMaxUsePercent:1},aca,yearAcaConfig:config,inflationIndex:1,medicalInflationIndex:1.1,age:60,yearIndex:0,filingStatus:'single',irmaaMagi:25000});
  close(costs.total,aca.netPremium+1100+330);
  assert.throws(()=>computeAca({magi:25000,config:{...acaConfig,csr:{...csr,silver94:{oopMaximum:100,expectedOop:200}}}}),/ACA/);
});
test('mixed member eligibility does not grant the reduced variant to an ineligible household',()=>{
  const calendar=[{member:'primary',year:2026,firstMonth:1,lastMonth:12,eligibility:'eligible',monthlyPremium:500,monthlyBenchmark:500},{member:'spouse',year:2026,firstMonth:1,lastMonth:12,eligibility:'unknown',monthlyPremium:500,monthlyBenchmark:500}];
  assert.equal(computeAca({magi:25000,config:{...acaConfig,coverageCalendar:calendar}}).costSharing.band,'standard');
});
test('conversion optimizer stops at a costly CSR threshold and sizes taxable-income limits as gross conversions',()=>{
  const p=setupIras([lot('ira',1000000)],250000);
  const config={...acaConfig,applicablePercentageTable:[{minFplPercent:100,maxFplPercent:400,initialRate:0,finalRate:0}],
    csr:{enabled:true,standard:{oopMaximum:20000,expectedOop:20000},silver94:{oopMaximum:3000,expectedOop:0},silver87:{oopMaximum:20000,expectedOop:20000},silver73:{oopMaximum:20000,expectedOop:20000}}};
  const args={portfolio:p,scenario:{...scenario,rothConversion:{enabled:true,targetMarginalRate:0.24,optimizeForAca:true,maxAcaFplPercent:400}},taxProfile:profile,ordinaryIncome:29000,age:60};
  const reduced=rothConversionAmountForYear({...args,acaConfig:config});
  const standard=rothConversionAmountForYear({...args,acaConfig:{...config,csr:{enabled:false}}});
  close(reduced,1000/0.75);assert.ok(standard>reduced+10000);
  close(conversionTaxableAmount(p,reduced),1000);
  assert.equal(p.iraLedger.primary.basis,250000);
});
test('lifetime gain policy includes the 150% CSR boundary and audits candidate OOP costs',()=>{
  const p=simulatePlan({assets:[lot('cash',200000,{accountType:'taxable'}),lot('stock',100000,{accountType:'taxable',assetClass:'stock',costBasisPerUnit:0.1})],
    taxProfile:profile,scenario:{...scenario,planYears:2,medicareWages:25000,aca:acaConfig,taxGainHarvesting:{enabled:true},withdrawalStrategy:{mode:'lifetime'}}});
  const candidate=p.gainHarvestingOptimization.candidates.find(row=>row.label==='Up to 150% FPL');
  assert.ok(candidate);assert.ok(candidate.years.every(year=>year.csrBand && Number.isFinite(year.expectedOop)));
});
test('new form values round-trip IRA, CSR, employment dates and Roth clocks',()=>{
  const original={traditionalIraBasis:25000,spouseTraditionalIraBasis:10000,aca:{csr},earnedIncomeEndYear:2028,
    spouseEarnedIncomeEndYear:2030,rothFirstContributionYear:2022,spouseRothFirstContributionYear:2025};
  const restored=applyPlanningExtensionControls({},planningExtensionControlsForScenario(original));
  assert.equal(restored.traditionalIraBasis,25000);assert.deepEqual(restored.aca.csr,csr);
  assert.equal(restored.earnedIncomeEndYear,2028);assert.equal(restored.spouseRothFirstContributionYear,2025);
});
test('employer HSA contributions create assets without a personal deduction or spending charge',()=>{
  const input={assets:[lot('cash',100000,{accountType:'taxable'})],taxProfile:profile,scenario:{...scenario,currentAge:50,
    taxEfficiencyStrategy:{hsaContributionEnabled:true,hsaCoverage:'self',hsaAnnualContribution:0,hsaPrimaryEmployerContribution:3000}}};
  const year=simulatePlan(input).years[0];
  assert.equal(year.hsaContribution.employerAmount,3000); assert.equal(year.hsaContribution.amount,0);
  assert.equal(year.endingPortfolioValue,102000);assert.equal(year.acaMagi,0);
  const included=simulatePlan({...input,scenario:{...input.scenario,taxEfficiencyStrategy:{...input.scenario.taxEfficiencyStrategy,hsaEmployerContributionsInOpeningBalance:true}}});
  assert.equal(included.years[0].endingPortfolioValue,99000);
});
test('recurring income and employer deposits stop separately for each earner',()=>{
  const result=simulatePlan({assets:[lot('cash',100000,{accountType:'taxable'})],taxProfile:jointProfile,
    scenario:{...scenario,currentAge:50,spouseAge:50,planYears:3,medicareWages:10000,spouseMedicareWages:20000,earnedIncomeEndYear:2026,spouseEarnedIncomeEndYear:2027,
      taxEfficiencyStrategy:{hsaContributionEnabled:true,hsaCoverage:'family',hsaAnnualContribution:0,hsaPrimaryEmployerContribution:1000,hsaSpouseEmployerContribution:1000,hsaSpouseEligibleMonths:12}}});
  assert.deepEqual(result.years.map(year=>year.hsaContribution.employerAmount),[2000,1000,0]);
  assert.deepEqual(result.years.map(year=>year.earnedIncome),[30000,20000,0]);
});
test('decedent carryforwards expire; survivor-owned losses retain their character',()=>{
  for(const decedent of ['primary','spouse']) {
    const result=simulatePlan({assets:[lot('cash',1000000,{accountType:'taxable'})],taxProfile:jointProfile,
      scenario:{...scenario,currentAge:70,spouseAge:70,planYears:2,primaryMortalityAge:decedent==='primary'?70:95,spouseMortalityAge:decedent==='spouse'?70:95,
        openingCapitalLossCarryforward:{shortTerm:10000,longTerm:0},spouseOpeningCapitalLossCarryforward:{shortTerm:0,longTerm:20000},medicareWages:40000,spouseMedicareWages:40000}});
    assert.deepEqual(result.years[1].lossCarryforwardByOwner[decedent],{shortTerm:0,longTerm:0});
    assert.ok(result.years[1].taxes.lossCarryforward>0);
  }
});
test('current-year harvested losses keep their owner through the final joint return',()=>{
  const result=simulatePlan({assets:[lot('loss',100000,{accountType:'taxable',assetClass:'stock',costBasisPerUnit:2}),lot('cash',1000000,{accountType:'taxable',owner:'spouse'})],taxProfile:jointProfile,
    scenario:{...scenario,currentAge:70,spouseAge:70,planYears:2,primaryMortalityAge:70,spouseMortalityAge:95,taxLossHarvesting:{enabled:true,mode:'manual',overrideMaxLoss:100000},spouseMedicareWages:50000}});
  assert.ok(result.years[0].lossCarryforwardByOwner.primary.longTerm>0);
  assert.equal(result.years[1].taxes.ordinaryLossOffset,0);assert.equal(result.years[1].taxes.lossCarryforward,0);
});
test('owner allocations use net losses of each character, including short-term gains',()=>{
  const result=advanceLossLedger({primary:{shortTerm:10000,longTerm:0},spouse:{shortTerm:10000,longTerm:0}},[{owner:'primary',gain:5000,taxType:'ordinary'}],{shortTerm:12000,longTerm:0});
  assert.deepEqual(result,{primary:{shortTerm:4000,longTerm:0},spouse:{shortTerm:8000,longTerm:0}});
});
test('earnings-test FRA adjustment restores own and spousal benefits with distinct reduction formulas',()=>{
  const result=simulatePlan({assets:[lot('cash',1000000,{accountType:'taxable'})],taxProfile:jointProfile,
    scenario:{...scenario,currentAge:70,spouseAge:62,planYears:6,socialSecurityStartAge:70,socialSecurityAnnualBenefit:48000*socialSecurityClaimFactor(70,1956),
      spouseSocialSecurityStartAge:62,spouseSocialSecurityAnnualBenefit:8400,spouseMedicareWages:100000,spouseEarnedIncomeEndYear:2030}});
  close(result.years[5].socialSecurityEarningsTest.spouse.payable,24000);
  assert.equal(result.years[5].socialSecurityEarningsTest.spouse.spousalCreditedMonths,60);
});
test('Roth qualification advances after five tax years and stays separate by owner',()=>{
  const p=[lot('roth',10000,{accountType:'roth'}),lot('spouseRoth',10000,{accountType:'roth',owner:'spouse'})];
  ensureRothLedger(p,{startYear:2026,rothFirstContributionYear:2022,spouseRothFirstContributionYear:2026});
  const options={age:60,ownerAges:{primary:60,spouse:60},calendarYear:2026};
  assert.equal(rothLedgerSummary(p,options).available,0);
  assert.equal(rothLedgerSummary(p,{...options,calendarYear:2027}).available,10000);
  const before=consumeRothDistribution(structuredClone(p.rothLedger),'primary',1000,{calendarYear:2026,isEarly:false,qualified:true});
  const after=consumeRothDistribution(structuredClone(p.rothLedger),'primary',1000,{calendarYear:2027,isEarly:false,qualified:false});
  assert.equal(before.earnings,1000);assert.equal(after.earnings,0);
});
