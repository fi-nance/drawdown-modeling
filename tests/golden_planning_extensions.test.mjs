import test from 'node:test';
import assert from 'node:assert/strict';
import { simulatePlan, runMonteCarlo, runHistoricalBacktests, DEFAULT_SCENARIO } from '../src/core/simulation.mjs';
import { buildTaxProfile } from '../src/data/taxData.mjs';
import { socialSecurityEarningsForYear as earnings, parseSocialSecurityWorkCalendar } from '../src/core/simulation/socialSecurityEarnings.mjs';
import { longevityStressScenarios, runLongevityStress } from '../src/core/longevityStress.mjs';
import { applyPlanningExtensionControls, planningExtensionControlsForScenario, EXTENSION_CONTROL_DEFAULTS } from '../src/core/planningExtensions.mjs';
const returns=Object.fromEntries(['cash','stock','bond','inflation','medicalInflation'].map(key=>[key,{mean:0,stdev:0}]));
const assets=[{id:'cash',accountType:'taxable',assetClass:'cash',units:100000,price:1,costBasisPerUnit:1}];
const profile=buildTaxProfile({filingStatus:'single',state:'Florida'});
const scenario={...DEFAULT_SCENARIO,startYear:2026,currentAge:62,spouseAge:null,planYears:1,targetSpend:1000,requiredSpendingFloor:1000,returnAssumptions:returns,aca:{enabled:false},medicare:{premiumsEnabled:false},rothConversion:{enabled:false},taxLossHarvesting:{enabled:false},taxGainHarvesting:{enabled:false}};
const baseSS={scenario:{startYear:2026,currentAge:62,socialSecurityStartAge:62},age:62,annualBenefit:24000,earnedIncome:44480,yearIndex:0};
test('SSA 2026 annual $1-for-$2 earnings test reduces benefits and credits withheld months',()=>{
 const result=earnings(baseSS);assert.equal(result.withheld,10000);assert.equal(result.payable,14000);assert.equal(result.creditedMonths,5);
 const atFra=earnings({...baseSS,age:67,earnedIncome:1000000,creditedMonths:12});assert.equal(atFra.withheld,0);assert.ok(atFra.payable>24000);
});
test('FRA-year test excludes earnings after FRA and raises later payments for current-year credits',()=>{
 const work=Array.from({length:12},(_,i)=>({owner:'primary',year:2026,month:i+1,earnings:i<4?18000:10000,substantialServices:false}));
 const result=earnings({...baseSS,scenario:{...baseSS.scenario,currentAge:66.5,socialSecurityStartAge:62,socialSecurityWorkCalendar:work},age:66.5,earnedIncome:152000});
 // Born in 1959: FRA 66y10m, four tested months. (72000-65160)/3.
 assert.equal(result.monthsBeforeFra,4);assert.equal(result.withheld,2280);assert.equal(result.method,'fra-year-calendar');assert.ok(result.payable>24000-2280);
});
test('first-year monthly rule preserves retired months despite pre-retirement wages',()=>{
 const calendar=parseSocialSecurityWorkCalendar(Array.from({length:12},(_,i)=>`primary, 2026, ${i+1}, ${i<6?10000:0}, no`).join('\n'));
 const result=earnings({...baseSS,scenario:{...baseSS.scenario,socialSecurityClaimMonth:7,socialSecurityWorkCalendar:calendar},earnedIncome:60000});
 assert.equal(result.payable,12000);assert.equal(result.withheld,0);assert.equal(result.method,'first-year-monthly');
 const missing=earnings({...baseSS,scenario:{...baseSS.scenario,socialSecurityClaimMonth:7},earnedIncome:60000});assert.equal(missing.payable,0);
});
test('working while claiming flows through actual Social Security cash and tax income',()=>{
 const result=simulatePlan({assets,scenario:{...scenario,medicareWages:44480,socialSecurityWages:44480,socialSecurityStartAge:62,socialSecurityAnnualBenefit:24000},taxProfile:profile});
 assert.equal(result.years[0].socialSecurityBenefits,14000);assert.equal(result.years[0].socialSecurityEarningsTest.primary.withheld,10000);
});
test('opening capital losses retain character and feed year-one tax netting',()=>{
 const result=simulatePlan({assets,scenario:{...scenario,medicareWages:40000,openingCapitalLossCarryforward:{shortTerm:4000,longTerm:5000}},taxProfile:profile});
 assert.equal(result.years[0].taxes.ordinaryLossOffset,3000);assert.deepEqual(result.years[0].lossCarryforwardDetail,{shortTerm:1000,longTerm:5000});
 assert.throws(()=>simulatePlan({assets,scenario:{...scenario,traditionalIraBasis:1000},taxProfile:profile}),/8606/);
});
test('advisory cash fees and gross-return fund expenses affect deterministic and stochastic balances',()=>{
 const input={assets,scenario:{...scenario,fees:{advisoryRate:0.01,fundExpenseRate:0.02,returnsNetOfFundExpenses:false}},taxProfile:profile};
 const plan=simulatePlan(input);assert.equal(plan.years[0].advisoryFees,1000);assert.equal(plan.years[0].fundExpenses,2000);assert.equal(plan.years[0].endingPortfolioValue,96000);
 const mc=runMonteCarlo({...input,runs:2});assert.equal(mc.summary.medianEndingValue,96000);
 const net=simulatePlan({...input,scenario:{...input.scenario,fees:{...input.scenario.fees,returnsNetOfFundExpenses:true}}});assert.equal(net.years[0].endingPortfolioValue,98000);
});
test('both death orders apply the surviving person budget and required floor',()=>{
 for(const survivor of ['primary','spouse']) {
 const plan=simulatePlan({assets,scenario:{...scenario,currentAge:70,spouseAge:70,planYears:2,primaryMortalityAge:survivor==='primary'?95:70,spouseMortalityAge:survivor==='spouse'?95:70,survivorBudgets:{primary:{enabled:true,requiredSpend:20000,flexibleSpend:3000},spouse:{enabled:true,requiredSpend:25000,flexibleSpend:4000}}},taxProfile:buildTaxProfile({state:'Florida',filingStatus:'marriedFilingJointly'}),inflationSequence:[0,0]});
 assert.equal(plan.years[1].requiredEssentialSpending,survivor==='primary'?20000:25000);assert.equal(plan.years[1].plannedSpending,survivor==='primary'?23000:29000);
 }
});
test('longevity cases extend each life independently and use a complete common horizon',()=>{
 const source={...scenario,currentAge:90,spouseAge:90,primaryMortalityAge:91,spouseMortalityAge:92,planYears:1};
 const cases=longevityStressScenarios(source,'marriedFilingJointly');assert.equal(cases.length,4);assert.equal(cases[1].scenario.primaryMortalityAge,96);assert.equal(cases[1].scenario.spouseMortalityAge,92);assert.equal(cases[2].scenario.primaryMortalityAge,91);assert.equal(cases[2].scenario.spouseMortalityAge,97);assert.equal(source.planYears,1);
 const result=runLongevityStress({assets,scenario:source,taxProfile:buildTaxProfile({state:'Florida',filingStatus:'marriedFilingJointly'}),runs:2});assert.ok(result.every(row=>row.scenario.planYears===8));assert.equal(result.length,4);
});
test('new setup controls round-trip histories, eligibility, fees, and survivor budgets',()=>{
 const controls={...EXTENSION_CONTROL_DEFAULTS,advisoryFeePercent:1,openingShortTermLoss:3000,spouseSurvivorBudgetEnabled:true,spouseSurvivorRequired:30000,acaCoverageCalendar:'child, 2026, 1, 12, eligible, 500, 500',irmaaRedeterminations:'2026, 80000, single, no'};
 const saved=applyPlanningExtensionControls({},controls);const restored=applyPlanningExtensionControls({},planningExtensionControlsForScenario(saved));assert.deepEqual(restored,saved);assert.equal(saved.fees.advisoryRate,0.01);assert.equal(saved.aca.coverageCalendar[0].member,'child');
 assert.throws(()=>applyPlanningExtensionControls({}, {...controls,advisoryFeePercent:'bad'}));
});

import { readFileSync } from 'node:fs';
test('every persisted extension control is present in the setup page exactly once',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 for(const id of Object.keys(EXTENSION_CONTROL_DEFAULTS)) assert.equal(html.split(`id="${id}"`).length-1,1,id);
});
