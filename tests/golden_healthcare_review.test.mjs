// IRS PTC Q&A, IRS Publication 969; CMS 2026 Medicare premiums; SSA handbook 2504.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeAcaForYear, medicalCostForYear } from '../src/core/simulation/medical.mjs';
import { buildAcaConfig } from '../src/data/taxData.mjs';
const aca = (extra = {}) => buildAcaConfig({ enabled: true, state: 'Florida', householdSize: 2, marketplaceMembers: 2, memberAges: [55,55], currentAge: 55, benchmarkPremiumOverride: 20000, selectedPlanPremiumOverride: 20000, ...extra });
const medical = (extra = {}) => medicalCostForYear({ scenario: { taxYear: 2026, medicare: { irmaaEnabled: false, partDMonthlyPremium: 30, medigapMonthlyPremium: 150, annualOopBase: 0, ...extra } }, aca: { netPremium: 0, medicareEligibleHousehold: true }, yearAcaConfig: { enabled: false }, inflationIndex: 1, age: 65, spouseAge: null, yearIndex: 0, filingStatus: 'single', irmaaMagi: 30000, magiHistory: [] });
test('MFS gets no PTC by default but still pays its gross Marketplace premium', () => {
  const result = computeAcaForYear({ age: 55, spouseAge: 55, magi: 40000, config: aca(), filingStatus: 'marriedFilingSeparately' });
  assert.equal(result.subsidy, 0); assert.equal(result.netPremium, 20000);
});
test('dependent Marketplace coverage survives both parents entering Medicare', () => {
  const result = computeAcaForYear({ age: 65, spouseAge: 65, magi: 150000, config: aca({ householdSize: 3, marketplaceMembers: 1, memberAges: [20], benchmarkPremiumOverride: 6000, selectedPlanPremiumOverride: 6000 }), filingStatus: 'marriedFilingJointly' });
  assert.equal(result.grossPremium, 6000);
});
test('turning off IRMAA retains base Medicare and supplement premiums', () => {
  assert.equal(medical().total, 4594.8);
  assert.equal(medical().medicare.partBMonthlyIrmaa, 0);
});
test('IRMAA uses filing status on the lookback tax return after spouse death', () => {
  const result = medicalCostForYear({ scenario: { taxYear: 2026, medicare: { annualOopBase: 0 } }, aca: { netPremium: 0, medicareEligibleHousehold: true }, yearAcaConfig: { enabled: false }, inflationIndex: 1, age: 69, spouseAge: null, yearIndex: 2, filingStatus: 'single', irmaaMagi: 0, magiHistory: [{ magi: 200000, filingStatus: 'marriedFilingJointly' }] });
  assert.equal(result.medicare.partBMonthlyIrmaa, 0);
  assert.equal(result.medicare.lookbackMagi, 200000);
});

import { simulatePlan, DEFAULT_SCENARIO } from '../src/core/simulation.mjs';
import { buildTaxProfile } from '../src/data/taxData.mjs';
import { hsaContributionForYear, addHsaContributionLot, hsaStrategyConfig } from '../src/core/simulation/hsa.mjs';
import { parseCoverageCalendar } from '../src/core/coverageCalendar.mjs';
test('ordinary ACA premiums never create qualified HSA receipts', () => {
 const plan = simulatePlan({ assets: [{ id:'hsa',accountType:'hsa',assetClass:'cash',units:50000,price:1 }, {id:'cash',accountType:'taxable',assetClass:'cash',units:1000,price:1,costBasisPerUnit:1}],
 scenario:{...DEFAULT_SCENARIO,currentAge:50,spouseAge:null,planYears:1,targetSpend:1000,medicalExpensesBase:0,expectedOopMaxUsePercent:0,rothConversion:{enabled:false},withdrawalOrder:['hsa','taxable'],aca:aca({householdSize:1,marketplaceMembers:1,memberAges:[50],benchmarkPremiumOverride:12000,selectedPlanPremiumOverride:12000})},taxProfile:buildTaxProfile({state:'Florida',filingStatus:'single'}),returnSequence:[{cash:0}],inflationSequence:[0] });
 assert.equal(plan.years[0].qualifiedHsaExpenses,0);assert.equal(plan.years[0].hsaWithdrawals,0);assert.equal(plan.years[0].unfunded,12000);
});
test('Medigap is excluded from HSA receipts while age-65 Medicare B and D qualify', () => {
 const result=medical(); assert.equal(result.qualifiedHsaExpenses,2794.8);
});
test('HSA catch-up amounts remain nominal and go into each eligible owner account', () => {
 const contribution=hsaContributionForYear({scenario:{taxEfficiencyStrategy:{hsaContributionEnabled:true,hsaCoverage:'family',hsaPrimaryEligibleMonths:12,hsaSpouseEligibleMonths:12}},age:60,spouseAge:60,inflationIndex:2});
 assert.equal(contribution.catchUpLimit,2000);assert.equal(contribution.byOwner.spouse,1000);
 const portfolio=[];addHsaContributionLot(portfolio,contribution);assert.equal(portfolio.find(row=>row.owner==='spouse').units,1000);
 const spouseOnly=hsaContributionForYear({scenario:{taxEfficiencyStrategy:{hsaContributionEnabled:true,hsaCoverage:'self',hsaSpouseEligibleMonths:6}},age:66,spouseAge:60,inflationIndex:1});assert.equal(spouseOnly.byOwner.primary,0);assert.equal(spouseOnly.byOwner.spouse,2700);
});
test('prior reimbursement and deductions reduce opening HSA expense support',()=>assert.equal(hsaStrategyConfig({taxEfficiencyStrategy:{startingHsaQualifiedExpenseBalance:10000,hsaPriorReimbursements:2000,hsaPriorDeductedExpenses:1000}}).startingQualifiedExpenseBalance,7000));
test('member calendar prorates PTC monthly, excludes employer eligibility, rejects overlaps',()=>{
 const calendar=parseCoverageCalendar('primary, 2026, 1, 6, eligible, 500, 500\nprimary, 2026, 7, 12, employer, 500, 500');
 const result=computeAcaForYear({age:55,spouseAge:null,magi:20000,config:{...aca({householdSize:1}),coverageCalendar:calendar},filingStatus:'single'});
 assert.ok(result.subsidy>0 && result.subsidy<3000);assert.equal(result.grossPremium,6000);assert.equal(result.monthlyDetails[6].subsidy,0);
 assert.throws(()=>parseCoverageCalendar('primary, 2026, 1, 12, eligible, 500, 500\nprimary, 2026, 3, 4, unknown, 500, 500'));
});
test('MFS Medicare counts both living enrollees independently of credit eligibility', () => {
 const result=medicalCostForYear({scenario:{taxYear:2026,medicare:{irmaaEnabled:false,partBEnrollees:2,annualOopBase:0}},aca:{netPremium:0},yearAcaConfig:{enabled:false},inflationIndex:1,age:66,spouseAge:66,yearIndex:0,filingStatus:'marriedFilingSeparately',irmaaMagi:0,magiHistory:[]});
 assert.equal(result.medicare.partBAnnualPremium,4869.6);
});
test('mixed-age household does not add Medicare premiums to unrestricted HSA receipts', () => {
 const result=medicalCostForYear({scenario:{taxYear:2026,medicare:{irmaaEnabled:false,annualOopBase:0}},aca:{netPremium:0},yearAcaConfig:{enabled:false},inflationIndex:1,age:60,spouseAge:66,yearIndex:0,filingStatus:'marriedFilingJointly',irmaaMagi:0,magiHistory:[]});
 assert.equal(result.medicare.partBAnnualPremium,2434.8);assert.equal(result.qualifiedHsaExpenses,0);
});
test('explicit calendar always interprets premiums as gross, even with a legacy net quote', () => {
 const calendar=parseCoverageCalendar('primary, 2026, 1, 12, eligible, 500, 500');
 const run=premiumInputMode=>computeAcaForYear({age:55,spouseAge:null,magi:20000,config:{...aca({householdSize:1}),coverageCalendar:calendar,premiumInputMode},filingStatus:'single'});
 assert.equal(run('net').subsidy,run('gross').subsidy);assert.ok(run('net').netPremium>0);
});
test('spouse survivor HSA contributions use the spouse eligibility and account',()=>{
 const result=simulatePlan({assets:[{id:'cash',accountType:'taxable',assetClass:'cash',units:100000,price:1,costBasisPerUnit:1}],scenario:{...DEFAULT_SCENARIO,currentAge:65,spouseAge:60,primaryMortalityAge:65,spouseMortalityAge:95,planYears:2,targetSpend:1000,aca:{enabled:false},medicare:{premiumsEnabled:false},taxEfficiencyStrategy:{hsaContributionEnabled:true,hsaCoverage:'self',hsaPrimaryEligibleMonths:0,hsaSpouseEligibleMonths:12},rothConversion:{enabled:false},taxLossHarvesting:{enabled:false},taxGainHarvesting:{enabled:false}},taxProfile:buildTaxProfile({state:'Florida',filingStatus:'marriedFilingJointly'}),returnSequence:[{cash:0},{cash:0}],inflationSequence:[0,0]});
 assert.equal(result.years[1].hsaContribution.byOwner.primary,0);assert.equal(result.years[1].hsaContribution.byOwner.spouse,5400);
});
