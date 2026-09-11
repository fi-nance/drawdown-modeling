import { parseCoverageCalendar } from './coverageCalendar.mjs';
import { parseSocialSecurityWorkCalendar } from './simulation/socialSecurityEarnings.mjs';

// Mapping makes new controls participate in the same save/restore and rescue
// application flows as legacy setup fields. Percent controls convert once.
const FIELDS = [
 ['medicarePremiumsEnabled','medicare.premiumsEnabled',true],
 ['twoYearsPriorFilingStatus','medicare.twoYearsPriorFilingStatus',''],
 ['priorYearFilingStatus','medicare.priorYearFilingStatus',''],
 ['twoYearsPriorMfsLivedTogether','medicare.twoYearsPriorMfsLivedTogether',false],
 ['priorYearMfsLivedTogether','medicare.priorYearMfsLivedTogether',false],
 ['acaPtcEligibility','aca.ptcEligibility','unknown'],
 ['acaMfsPtcException','aca.mfsPtcException',false],
 ['hsaOpeningReceiptTotal','taxEfficiencyStrategy.startingHsaQualifiedExpenseBalance',0],
 ['hsaPriorReimbursements','taxEfficiencyStrategy.hsaPriorReimbursements',0],
 ['hsaPriorDeductedExpenses','taxEfficiencyStrategy.hsaPriorDeductedExpenses',0],
 ['hsaEligibleInsurancePremiumAnnual','taxEfficiencyStrategy.hsaEligibleInsurancePremiumAnnual',0],
 ['hsaPrimaryEligibleMonths','taxEfficiencyStrategy.hsaPrimaryEligibleMonths',12],
 ['hsaSpouseEligibleMonths','taxEfficiencyStrategy.hsaSpouseEligibleMonths',0],
 ['hsaPrimaryEmployerContribution','taxEfficiencyStrategy.hsaPrimaryEmployerContribution',0],
 ['hsaSpouseEmployerContribution','taxEfficiencyStrategy.hsaSpouseEmployerContribution',0],
 ['hsaSpouseBaseShare','taxEfficiencyStrategy.hsaSpouseBaseShare',0,100],
 ['openingShortTermLoss','openingCapitalLossCarryforward.shortTerm',0],
 ['openingLongTermLoss','openingCapitalLossCarryforward.longTerm',0],
 ['traditionalIraBasis','traditionalIraBasis',0],
 ['spouseTraditionalIraBasis','spouseTraditionalIraBasis',0],
 ['advisoryFeePercent','fees.advisoryRate',0,100],
 ['returnsNetOfFundExpenses','fees.returnsNetOfFundExpenses',true],
 ['fundExpensePercent','fees.fundExpenseRate',0,100],
 ['primarySurvivorBudgetEnabled','survivorBudgets.primary.enabled',false],
 ['primarySurvivorRequired','survivorBudgets.primary.requiredSpend',0],
 ['primarySurvivorFlexible','survivorBudgets.primary.flexibleSpend',0],
 ['spouseSurvivorBudgetEnabled','survivorBudgets.spouse.enabled',false],
 ['spouseSurvivorRequired','survivorBudgets.spouse.requiredSpend',0],
 ['spouseSurvivorFlexible','survivorBudgets.spouse.flexibleSpend',0],
 ['socialSecurityClaimMonth','socialSecurityClaimMonth',1],
 ['spouseSocialSecurityClaimMonth','spouseSocialSecurityClaimMonth',1]
];
export const EXTENSION_CONTROL_DEFAULTS = Object.freeze({ ...Object.fromEntries(FIELDS.map(([id,,value])=>[id,value])), acaCoverageCalendar:'', socialSecurityWorkCalendar:'', irmaaRedeterminations:'' });
const get = (object,path) => path.split('.').reduce((value,key)=>value?.[key],object);
function set(object,path,value) {
 const keys=path.split('.'); let target=object;
 keys.forEach((key,index)=>{if(index===keys.length-1) target[key]=value; else target=target[key]={...(target[key]??{})};});
}
export function applyPlanningExtensionControls(scenario, controls) {
 const output={...scenario};
 for(const [id,path,fallback,scale=1] of FIELDS) {
   const raw=controls[id]??fallback;
   const value=typeof fallback==='boolean'?Boolean(raw):typeof fallback==='number'?Number(raw)/scale:String(raw);
   if(typeof value==='number' && (!Number.isFinite(value)||value<0)) throw new Error(`${id}: enter a finite, nonnegative number.`);
   if (['hsaPrimaryEligibleMonths','hsaSpouseEligibleMonths'].includes(id) && (!Number.isInteger(value) || value > 12)) throw new Error(`${id}: eligible months must be a whole number from 0 to 12.`);
   if (['socialSecurityClaimMonth','spouseSocialSecurityClaimMonth'].includes(id) && (!Number.isInteger(value) || value < 1 || value > 12)) throw new Error(`${id}: claim month must be a whole number from 1 to 12.`);
   if (['advisoryFeePercent','fundExpensePercent'].includes(id) && value > 0.1) throw new Error(`${id}: enter a percentage from 0 to 10.`);
   if (id === 'hsaSpouseBaseShare' && value > 1) throw new Error('HSA spouse base share must be from 0 to 100%.');
   set(output,path,value);
 }
 output.aca.coverageCalendar=parseCoverageCalendar(controls.acaCoverageCalendar);
 output.socialSecurityWorkCalendar=parseSocialSecurityWorkCalendar(controls.socialSecurityWorkCalendar);
 output.medicare.irmaaOverrides=parseIrmaaRedeterminations(controls.irmaaRedeterminations);
 return output;
}
export function planningExtensionControlsForScenario(scenario) {
 const controls={};
 for(const [id,path,,scale=1] of FIELDS) { const value=get(scenario,path); if(value!==undefined) controls[id]=typeof value==='number'?value*scale:value; }
 if(Array.isArray(scenario.aca?.coverageCalendar)) controls.acaCoverageCalendar=scenario.aca.coverageCalendar.map(row=>[row.member,row.year,row.firstMonth,row.lastMonth,row.eligibility,row.monthlyBenchmark,row.monthlyPremium].join(', ')).join('\n');
 if(Array.isArray(scenario.socialSecurityWorkCalendar)) controls.socialSecurityWorkCalendar=scenario.socialSecurityWorkCalendar.map(row=>[row.owner,row.year,row.month,row.earnings,row.substantialServices?'yes':'no'].join(', ')).join('\n');
 if(Array.isArray(scenario.medicare?.irmaaOverrides)) controls.irmaaRedeterminations=scenario.medicare.irmaaOverrides.map(row=>[row.year,row.magi,row.filingStatus,row.marriedFilingSeparatelyLivedTogether?'yes':'no'].join(', ')).join('\n');
 return controls;
}
function parseIrmaaRedeterminations(text) {
 if(!String(text??'').trim()) return [];
 const years=new Set();
 return String(text).trim().split(/\r?\n/).filter(line=>line.trim()).map((line,index)=>{
  const [yearText,magiText,filingStatus,together='no',...extra]=line.split(',').map(value=>value.trim());
  const year=Number(yearText),magi=Number(magiText);
  if(extra.length||!/^\d{4}$/.test(yearText??'')||!magiText||!Number.isFinite(magi)||magi<0||!['single','marriedFilingJointly','marriedFilingSeparately','headOfHousehold'].includes(filingStatus)||!['yes','no'].includes(together)||years.has(year)) throw new Error(`IRMAA redetermination line ${index+1}: enter premium year, MAGI, filing status, lived together (yes/no).`);
  years.add(year); return {year,magi,filingStatus,marriedFilingSeparatelyLivedTogether:together==='yes'};
 });
}
