import test from 'node:test';
import assert from 'node:assert/strict';
import { computeIncomeTax, computeChildTaxCreditBreakdown } from '../src/core/tax.mjs';
import { buildTaxProfile } from '../src/data/taxData.mjs';
import { simulatePlan, DEFAULT_SCENARIO } from '../src/core/simulation.mjs';
import { hsaContributionForYear } from '../src/core/simulation/hsa.mjs';
import { estimateHeirValueBreakdown } from '../src/core/simulation/heirEstate.mjs';
import { spouseSocialSecurityBenefitsForYear } from '../src/core/simulation/socialSecurity.mjs';
import { validateUserPlanningScenario } from '../src/core/planningInputValidation.mjs';
import { applyTotalReturnsWithIncome, sellFromLot } from '../src/core/portfolio.mjs';
import { parsePortfolioJson, parsePortfolioCsv } from '../src/core/importers.mjs';
import { prepareRetirementAccounts, ensureIraLedger } from '../src/core/iraBasis.mjs';
import { normalizeDecisionProfile } from '../src/core/decisionEngine.mjs';
import { applyPlanningExtensionControls, planningExtensionControlsForScenario } from '../src/core/planningExtensions.mjs';

const close = (actual, expected, tolerance = 0.02) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const lot = (id, value, extra = {}) => ({id, name:id, accountType:'taxable', assetClass:'cash', units:value, price:1, costBasisPerUnit:1, ...extra});
const profile = buildTaxProfile({filingStatus:'single', state:'Florida'});
const scenario = {...DEFAULT_SCENARIO, startYear:2026, currentAge:60, spouseAge:null, planYears:1,
  targetSpend:10000, medicalExpensesBase:2000, expectedOopMaxUsePercent:0,
  aca:{enabled:false}, medicare:{premiumsEnabled:false}, rothConversion:{enabled:false},
  taxLossHarvesting:{enabled:false}, taxGainHarvesting:{enabled:false}};
const run = (overrides = {}, assets = [lot('cash',1000000)], taxProfile = profile) => simulatePlan({assets,
  taxProfile, scenario:{...scenario,...overrides}, returnSequence:[{cash:0,stock:0,bond:0}], inflationSequence:[0]});

test('fixed-budget decision defaults ignore a larger inactive guardrail budget but honor explicit needs', () => {
  const s = {...scenario,targetSpend:40000,spendingStrategy:{mode:'fixed',essentialSpend:60000,discretionarySpend:30000}};
  const automatic = normalizeDecisionProfile({requiredSpend:null,flexibleSpend:null},s);
  assert.equal(automatic.requiredSpend,40000);
  assert.equal(automatic.flexibleSpend,0);
  assert.equal(automatic.targetSpend,40000);
  assert.equal(run({...s,requiredSpendingFloor:automatic.requiredSpend}).spendingOutcome.essentialSatisfied,true);
  assert.equal(normalizeDecisionProfile({requiredSpend:60000,flexibleSpend:0},s).requiredSpend,60000);
  assert.equal(normalizeDecisionProfile({requiredSpend:20000,flexibleSpend:0},s).flexibleSpend,0);
});

test('separate California opening loss forms round-trip without replacing federal history', () => {
  const inputs = {useStateLossHistory:true,openingShortTermLoss:1000,openingStateShortTermLoss:3000,spouseOpeningStateLongTermLoss:5000};
  const s = applyPlanningExtensionControls(scenario,inputs);
  assert.equal(s.openingCapitalLossCarryforward.shortTerm,1000);
  assert.equal(s.openingStateCapitalLossCarryforward.shortTerm,3000);
  assert.equal(planningExtensionControlsForScenario(s).spouseOpeningStateLongTermLoss,5000);
  assert.equal(applyPlanningExtensionControls(scenario,{...inputs,useStateLossHistory:false}).openingStateCapitalLossCarryforward,undefined);
});

test('TIPS ladder coupon and inflation accrual are federally taxable but state-exempt', () => {
  const result = simulatePlan({assets:[lot('cash',1000000)],taxProfile:buildTaxProfile({state:'California',filingStatus:'single'}),
    scenario:{...scenario,planYears:2,medicalExpensesBase:0,tipsLadder:{enabled:true,years:2,annualRealAmount:10000,realYieldPercent:2}},
    returnSequence:[{cash:0},{cash:0}],inflationSequence:[0.1,0]});
  const y = result.years[1];
  assert.ok(y.tipsLadder.phantomIncome>0);
  close(y.taxes.stateTaxBreakdown.stateExemptInterest,y.tipsLadder.phantomIncome+y.tipsLadder.taxableCouponCash);
  assert.ok(y.acaMagi>0);
  close(y.taxes.stateTaxBreakdown.stateIncomeBeforeDeduction,0);
});

test('NIIT subtracts only the allowable current-year investment capital loss deduction', () => {
  const income = {ordinaryIncome:300000, ordinaryInvestmentIncome:15000, shortTermCapitalLosses:5000, profile};
  close(computeIncomeTax(income).niitTax,456);
  close(computeIncomeTax({...income, ordinaryInvestmentIncome:2000}).niitTax,0);
  close(computeIncomeTax({...income, profile:buildTaxProfile({filingStatus:'marriedFilingSeparately',state:'Florida'})}).niitTax,513);
  close(computeIncomeTax({...income, shortTermCapitalLosses:5000, longTermCapitalGains:10000}).niitTax,760);
});

test('Schedule 8812 priority credits leave unused child credit for the earned-income ACTC limit', () => {
  const p = buildTaxProfile({filingStatus:'marriedFilingJointly', qualifyingChildren:2, creditsBeforeChildTaxCredit:3000});
  const result = computeChildTaxCreditBreakdown({magi:50000, federalIncomeTaxBeforeCredits:3000,
    earnedIncomeForRefundableCredits:50000, profile:p});
  assert.equal(result.nonrefundableChildTaxCredit,0);
  assert.equal(result.additionalChildTaxCredit,3400);
  assert.equal(result.federalCreditsUsed,3000);
  const after = computeChildTaxCreditBreakdown({magi:50000, federalIncomeTaxBeforeCredits:3000,
    earnedIncomeForRefundableCredits:50000, additionalCredits:3000, profile:{...p,creditsBeforeChildTaxCredit:0}});
  assert.equal(after.additionalChildTaxCredit,1400);
  assert.equal(after.additionalCreditsUsed,0);
  assert.equal(computeChildTaxCreditBreakdown({profile:p, federalIncomeTaxBeforeCredits:3000}).additionalChildTaxCredit,0);
});

test('LTC remains an additional funded stress expense when ordinary medical is in the budget', () => {
  const config = {targetSpendIncludesMedical:true, ltcStress:{enabled:true,annualCost:100000,startAge:60,years:1,owner:'primary'}};
  const stressed = run(config).years[0], baseline = run({targetSpendIncludesMedical:true}).years[0];
  assert.equal(stressed.ltcCost,100000);
  assert.equal(stressed.medicalCost,100000);
  assert.equal(stressed.medicalCostIncludedInSpending,2000);
  close(baseline.endingPortfolioValue - stressed.endingPortfolioValue,100000);
  close(run(config,[lot('cash',50000)]).years[0].unfunded,60000);
  const separate = run({...config,targetSpendIncludesMedical:false}).years[0];
  assert.equal(separate.medicalCost,102000);
});

test('HSA coverage must be explicit; ACA enrollment and marriage cannot infer HDHP coverage', () => {
  const config = {hsaContributionEnabled:true,hsaCoverage:'auto'};
  assert.throws(() => hsaContributionForYear({scenario:{taxEfficiencyStrategy:config},age:50,spouseAge:50,inflationIndex:1}),/Select actual/);
  assert.equal(validateUserPlanningScenario({...scenario,taxEfficiencyStrategy:config}).ok,false);
  const family = hsaContributionForYear({scenario:{aca:{enabled:false},taxEfficiencyStrategy:{...config,hsaCoverage:'family'}},age:50,spouseAge:50,inflationIndex:1});
  assert.equal(family.amount,8750);
});

test('limited family HSA deposits fund catch-ups in separate eligible owner accounts', () => {
  const result = hsaContributionForYear({scenario:{taxEfficiencyStrategy:{hsaContributionEnabled:true,
    hsaCoverage:'family',hsaSpouseEligibleMonths:12,hsaAnnualContribution:8750}},age:60,spouseAge:60,inflationIndex:1});
  assert.equal(result.amount,8750);
  assert.deepEqual(result.byOwner,{primary:7750,spouse:1000});
});

test('estate-tax IRD deduction applies only to taxable non-spouse IRD and retains the full estate tax charge', () => {
  const assets = [lot('cash',15000000),lot('ira',10000000,{accountType:'traditional'})];
  const options = {heirType:'nonSpouse10Yr',taxProfile:{ordinaryBrackets:[{upTo:Infinity,rate:0.24}],standardDeduction:0}};
  const result = estimateHeirValueBreakdown(assets,0.24,options);
  assert.equal(result.federalEstateTax,4000000);
  assert.equal(result.federalEstateTaxAttributableToIrd,4000000);
  assert.equal(result.traditionalIncomeTaxEstimate,1440000);
  assert.equal(result.afterTaxValue,19560000);
  assert.equal(estimateHeirValueBreakdown(assets,0.24,{...options,heirType:'spouse'}).federalEstateTaxAttributableToIrd,0);
  assert.equal(estimateHeirValueBreakdown([lot('ira',1000000,{accountType:'traditional'})],0.24,options).federalEstateTaxAttributableToIrd,0);
});

test('progressive heir taxes use the larger of standard or allocated IRD deduction and exclude IRA basis', () => {
  const options = {heirType:'nonSpouse10Yr',heirBaseIncome:80000,
    taxProfile:{ordinaryBrackets:[{upTo:100000,rate:0.2},{upTo:Infinity,rate:0.3}],standardDeduction:30000}};
  const standardWins = estimateHeirValueBreakdown([lot('cash',15000000),lot('ira',500000,{accountType:'traditional'})],0.24,options);
  assert.equal(standardWins.federalEstateTaxAttributableToIrd,200000);
  assert.equal(standardWins.traditionalIncomeTaxEstimate,100000);
  const assets = prepareRetirementAccounts([lot('cash',15000000),lot('ira',10000000,
    {accountType:'traditional',nondeductibleBasis:2000000})]);
  ensureIraLedger(assets);
  const irdWins = estimateHeirValueBreakdown(assets,0.24,options);
  assert.equal(irdWins.taxableIrdValue,8000000);
  assert.equal(irdWins.federalEstateTaxAttributableToIrd,3200000);
  assert.equal(irdWins.traditionalIncomeTaxEstimate,1480000);
});

test('own-worker spouse SS input receives exactly one independently calculated spousal supplement', () => {
  const result = spouseSocialSecurityBenefitsForYear({...scenario,startYear:2027,currentAge:67,spouseAge:67,
    socialSecurityStartAge:67,socialSecurityAnnualBenefit:40000,spouseSocialSecurityStartAge:67,
    spouseSocialSecurityAnnualBenefit:15000},67,1,profile,{primaryAge:67,components:true});
  assert.equal(result[0].annualBenefit,15000);
  assert.equal(result[1].annualBenefit,5000);
});

test('2026 active QBI minimum is retained, but not granted without material participation confirmation', () => {
  const calculate = confirmed => computeIncomeTax({ordinaryIncome:50000, profile:buildTaxProfile({filingStatus:'single',
    qbiSourceMode:'manual', qbiAmount:1000, qbiMaterialParticipation:confirmed})}).qbiDeduction;
  assert.equal(calculate(true),400);
  assert.equal(calculate(false),200);
});

test('Roth 403(b) imports have the same explicit rollover remedy as Roth 401(k)', () => {
  const imported = parsePortfolioJson(JSON.stringify([lot('roth',10000,{accountType:'Roth 403(b)'})]));
  assert.equal(imported[0].accountSubtype,'roth403b');
  assert.throws(() => prepareRetirementAccounts(imported),/completed rollover/);
  assert.equal(prepareRetirementAccounts([{...imported[0],rolloverToIraAtStart:true}])[0].accountSubtype,'rothIra');
});

test('HSA reinvestment increases state basis without recognizing unrealized price gains', () => {
  const assets = [lot('hsa',10000,{accountType:'hsa',assetClass:'stock',units:100,price:100,costBasisPerUnit:50,dividendYield:0.1})];
  const income = applyTotalReturnsWithIncome(assets,{stock:0});
  close(income.hsaInvestmentIncome,1000);
  close(income.ordinaryDividends,0);
  close(assets[0].units * assets[0].costBasisPerUnit,6000);
  const sale = sellFromLot(assets[0],10000);
  close(sale.hsaCapitalGain,4000);
  assert.equal(sale.gain,0);
});

test('CA and NJ add back HSA contributions and earnings, exclude already-taxed distributions and Treasury interest', () => {
  for (const state of ['California','New Jersey','New York']) {
    const p = buildTaxProfile({state,filingStatus:'single'});
    p.state = {...p.state,hsaPersonalContribution:4000,hsaEmployerContribution:1000,hsaInvestmentIncome:500,stateExemptInterest:2000};
    const taxes = computeIncomeTax({ordinaryIncome:105000,adjustmentsToIncome:4000,hsaOrdinaryIncome:5000,
      hsaCapitalGains:{shortTerm:0,longTerm:1000},profile:p});
    assert.equal(taxes.federalAgi,101000);
    const adjusted = state !== 'New York';
    assert.equal(taxes.stateTaxBreakdown.hsaIncomeAdjustment,adjusted ? 500 : 0);
    assert.equal(taxes.stateTaxBreakdown.stateIncomeBeforeDeduction,adjusted ? 100500 : 99000);
  }
});

test('CA HSA investment losses carry separately; NJ has no ordinary capital-loss deduction or carryover', () => {
  for (const state of ['California','New Jersey']) {
    const p = buildTaxProfile({state,filingStatus:'single'});
    const taxes = computeIncomeTax({ordinaryIncome:100000,hsaCapitalGains:{shortTerm:0,longTerm:-10000},profile:p});
    assert.equal(taxes.ordinaryLossOffset,0);
    assert.equal(taxes.stateTaxBreakdown.stateIncomeBeforeDeduction,state === 'California' ? 97000 : 100000);
    assert.equal(taxes.stateTaxBreakdown.capitalLossCarryforward.longTerm,state === 'California' ? 7000 : 0);
    const treatment = taxes.stateTaxBreakdown.capitalLossTreatment;
    assert.equal(treatment.ordinaryLossOffsetIncluded,state === 'California' ? 3000 : 0);
    assert.equal(treatment.assumption,state === 'California' ? 'separate-california-capital-loss-ledger' : 'new-jersey-current-year-gains-only');
    assert.deepEqual(treatment.stateCarryforwardForNextYear,taxes.stateTaxBreakdown.capitalLossCarryforward);
    const lowIncome = computeIncomeTax({hsaCapitalGains:{shortTerm:0,longTerm:-10000},profile:p});
    assert.equal(lowIncome.stateTaxBreakdown.capitalLossCarryforward.longTerm,state === 'California' ? 10000 : 0);
  }
});

test('state-only HSA income reaches the complete cash-funding calculation', () => {
  const assets = [lot('cash',100000),lot('hsa',10000,{accountType:'hsa',assetClass:'stock',units:100,price:100,costBasisPerUnit:20,dividendYield:0.1})];
  const result = run({targetSpend:20000,medicalExpensesBase:0,withdrawalOrder:['hsa','taxable'],
    withdrawalStrategy:{mode:'heuristic'},
    taxEfficiencyStrategy:{startingHsaQualifiedExpenseBalance:20000}},assets,buildTaxProfile({state:'California',filingStatus:'single'})).years[0];
  close(result.taxes.stateTaxBreakdown.hsaIncomeAdjustment,1000);
  close(result.taxes.stateTaxBreakdown.hsaCapitalGains.longTerm,7000);
  assert.ok(result.taxes.stateTax > 0);
  assert.equal(result.acaMagi,0);
  assert.equal(result.unfunded,0);
});

test('HSA allocation trades retain state gains and subsequent years do not repeat realized losses', () => {
  const result = simulatePlan({assets:[lot('cash',100000),lot('hsa',10000,{accountType:'hsa',assetClass:'stock',units:100,price:100,costBasisPerUnit:200})],
    taxProfile:buildTaxProfile({state:'California',filingStatus:'single'}),
    scenario:{...scenario,planYears:2,medicalExpensesBase:0,medicareWages:100000,
      allocationStrategy:{rebalanceEnabled:true,targetStockPercent:0,rebalanceBandPercent:0}},
    returnSequence:[{cash:0,stock:0,bond:0},{cash:0,stock:0,bond:0}],inflationSequence:[0,0]});
  assert.equal(result.years[0].stateLossCarryforward.longTerm,7000);
  assert.equal(result.years[1].stateLossCarryforward.longTerm,4000);
  assert.equal(result.years[0].lossCarryforward,0);
});

test('Treasury qualifying interest share survives imports and never exempts sale gains', () => {
  const csv = 'id,accountType,assetClass,units,price,costBasisPerUnit,dividendYield,stateExemptInterestShare\nt,taxable,bond,100,100,50,0.05,1';
  const assets = parsePortfolioCsv(csv);
  const income = applyTotalReturnsWithIncome(assets,{bond:0.05});
  assert.equal(income.stateExemptInterest,500);
  assert.equal(sellFromLot(assets[0],10000).gain,5000);
  assert.throws(() => parsePortfolioJson(JSON.stringify([lot('bad',100,{stateExemptInterestShare:2})])),/fraction/);
});
