// Primary sources: KS DOR individual FAQ; MI ORS PA4 FAQ; NJ njit7;
// NY Information for retired persons; IRS Topic 559 and 1040 QD/CG worksheet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stateRetirementIncomeExclusion as pension, stateSocialSecurityExclusion as ss, stateRetirementRulesFor as rule } from '../src/data/stateRetirementTax2026.mjs';
import { buildTaxProfile } from '../src/data/taxData.mjs';
import { computeIncomeTax } from '../src/core/tax.mjs';
import { simulatePlan, DEFAULT_SCENARIO } from '../src/core/simulation.mjs';
const cash = [{ id: 'cash', accountType: 'taxable', assetClass: 'cash', units: 100000, price: 1, costBasisPerUnit: 1 }];
const scenario = { ...DEFAULT_SCENARIO, currentAge: 60, spouseAge: 60, planYears: 1, targetSpend: 30000, aca: { enabled: false }, medicare: { premiumsEnabled: false }, rothConversion: { enabled: false }, taxLossHarvesting: { enabled: false }, taxGainHarvesting: { enabled: false } };
test('Kansas excludes federally included Social Security without an AGI cap', () => assert.equal(ss({rule:rule('Kansas'), filingStatus:'single', age:70, taxableSocialSecurity:30000, stateIncome:100000}),30000));
test('Michigan 2026 private retirement exclusion is capped', () => {
  for (const [filingStatus, expected] of [['single',67610],['marriedFilingJointly',135220]]) assert.equal(pension({rule:rule('Michigan'),filingStatus,age:65,retirementIncome:300000}),expected);
});
test('NJ pension exclusion follows both income bands and eligible income ownership', () => {
  for (const [stateIncome, expected] of [[100000,100000],[100001,60000],[125000,60000],[125001,30000],[150000,30000],[150001,0]]) assert.equal(pension({rule:rule('New Jersey'),filingStatus:'marriedFilingJointly',age:65,retirementIncome:120000,stateIncome}),expected);
  assert.equal(pension({rule:rule('New Jersey'),filingStatus:'headOfHousehold',age:65,retirementIncome:100000,stateIncome:100000}),75000);
  assert.equal(pension({rule:rule('New Jersey'),filingStatus:'marriedFilingJointly',age:65,spouseAge:50,retirementIncome:60000,stateIncome:60000,retirementIncomeDetails:[{owner:'spouse',amount:60000}]}),0);
});
test('New York individual limits flow from both pension owners through the full simulation', () => {
  for (const [spouseAge, spouseAmount, expected] of [[60,30000,40000],[50,30000,20000],[60,5000,25000]]) {
    const plan=simulatePlan({assets:cash,scenario:{...scenario,spouseAge,incomeStreams:[{type:'pension',owner:'primary',startAge:40,annualAmount:30000},{type:'pension',owner:'spouse',startAge:40,annualAmount:spouseAmount}]},taxProfile:buildTaxProfile({state:'New York',filingStatus:'marriedFilingJointly'})});
    assert.equal(plan.years[0].taxes.stateTaxBreakdown.retirementExclusion,expected);
  }
});
test('passive rental income is NII; qualified pension income is not', () => {
  for (const [netInvestmentIncome, expected] of [[undefined,1900],[false,0]]) {
    const plan=simulatePlan({assets:cash,scenario:{...scenario,incomeStreams:[{type:'pension',owner:'primary',startAge:60,annualAmount:250000},{type:'rent',owner:'primary',startAge:60,annualAmount:50000,netInvestmentIncome}]},taxProfile:buildTaxProfile({state:'Florida',filingStatus:'marriedFilingJointly'}),returnSequence:[{cash:0}]});
    assert.equal(plan.years[0].taxes.niitTax,expected);
  }
});
test('preferential tax cannot exceed all-ordinary treatment and details reconcile', () => {
  const tax=computeIncomeTax({ordinaryIncome:66000,qualifiedDividends:100,profile:buildTaxProfile({state:'Florida',filingStatus:'single'})});
  assert.equal(tax.federalIncomeTaxBeforeCredits,5752);
  assert.equal(tax.federalOrdinaryTax+tax.federalPreferentialTax,5752);
});
test('updated state retirement limits avoid obsolete or unsupported automatic exclusions',()=>{
 assert.equal(pension({rule:rule('Louisiana'),filingStatus:'single',age:65,retirementIncome:30000}),12000);
 assert.equal(pension({rule:rule('South Carolina'),filingStatus:'single',age:60,retirementIncome:30000}),3000);
 assert.equal(pension({rule:rule('Maryland'),filingStatus:'single',age:70,retirementIncome:50000,retirementIncomeDetails:[{owner:'primary',type:'ira',amount:50000}]}),0);
 for(const [stateIncome,expected] of [[25000,6000],[28000,3000],[31000,0]]) assert.equal(pension({rule:rule('Missouri'),filingStatus:'single',age:60,retirementIncome:6000,stateIncome}),expected);
});
test('Wisconsin age-67 cap has no income limit and joint doubling requires two eligible lives',()=>{
 const input={rule:rule('Wisconsin'),filingStatus:'marriedFilingJointly',age:67,spouseAge:67,retirementIncome:80000,stateIncome:100000};
 assert.equal(pension(input),48000);assert.equal(pension({...input,spouseAge:66}),24000);assert.equal(pension({...input,age:66,spouseAge:66}),0);
 assert.equal(pension({...input,age:65,spouseAge:65,stateIncome:29999}),5000);assert.equal(pension({...input,age:65,spouseAge:65,stateIncome:30000}),0);
});
test('Maine pension cap accounts for all Social Security and income phaseout',()=>{
 const input={rule:rule('Maine'),filingStatus:'single',age:65,retirementIncome:60000,totalSocialSecurity:30000,stateIncome:90000};
 assert.equal(pension(input),19824);assert.equal(pension({...input,stateIncome:175000}),9912);assert.equal(pension({...input,stateIncome:225000}),0);
 const meProfile=buildTaxProfile({state:'Maine',filingStatus:'single'});meProfile.state.primaryAge=65;
 const tax=computeIncomeTax({ordinaryIncome:85500,retirementOrdinaryIncome:60000,taxableSocialSecurity:25500,nonTaxableSocialSecurity:4500,profile:meProfile});assert.equal(tax.stateTaxBreakdown.retirementExclusion,19824);
});
