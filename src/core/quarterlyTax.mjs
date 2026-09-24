// 2026 Form 1040-ES regular installments. No payments, penalty calculation or
// Schedule AI annualization. Python's quarterly.py shares this versioned contract.
import { isoDay } from './lotDates.mjs';
export const QUARTERLY_DUE_DATES=['2026-04-15','2026-06-15','2026-09-15','2027-01-15'];
const statuses=['single','marriedFilingJointly','marriedFilingSeparately','headOfHousehold','qualifyingSurvivingSpouse'];
const methods=['Full-year return','No-tax exception','Unavailable'];
const fail=message=>{throw new Error(`Quarterly tax: ${message}`);};
const cents=value=>Math.sign(value)*Math.round((Math.abs(value)+1e-9)*100);
const amount=(value,label,negative=false)=>{
  if(typeof value!=='number'||!Number.isFinite(value)||value<(negative?-1e9:0)||value>1e9) fail(`${label} requires an explicit valid amount.`);
  return cents(value)/100;
};

export function validateQuarterlyTax(data,ytd) {
  if(!data||data.version!==1||data.taxYear!==2026||data.taxYear!==ytd.taxYear
    ||data.through!==ytd.through||data.reviewedSourceExportedAt!==ytd.reviewedSourceExportedAt
    ||!isoDay(data.through)||data.through<'2026-01-01'||data.through>'2027-12-31') fail('version, 2026 planning window or source review mismatch.');
  if(data.coverageReviewed!==true||data.regularInstallmentsReviewed!==true) fail('payment coverage and regular-installment eligibility must be reviewed.');
  if(!statuses.includes(data.filingStatus)||!methods.includes(data.priorYearMethod)) fail('unsupported filing status or prior-year method.');
  const method=data.priorYearMethod;
  const priorYearAgi=method==='Full-year return'?amount(data.priorYearAgi,'prior-year AGI',true):null;
  const priorYearTax=method!=='Unavailable'?amount(data.priorYearTax,'prior-year adjusted tax'):null;
  if(method==='Full-year return'&&priorYearTax<=0) fail('zero prior tax needs the reviewed No-tax exception or Unavailable method.');
  if(method==='No-tax exception'&&priorYearTax!==0) fail('the no-tax exception requires zero prior-year tax.');
  if(!Array.isArray(data.payments)||data.payments.length>10000) fail('missing or oversized payment ledger.');
  const seen=new Set();
  const payments=data.payments.map(p=>{
    if(!p||typeof p.id!=='string'||!p.id||p.id.length>2000||seen.has(p.id)) fail('invalid or duplicate payment ID.');
    seen.add(p.id);
    if(!['Federal','State'].includes(p.jurisdiction)||!['Withholding','Estimated','Prior-year credit'].includes(p.kind)
      ||!['Paid','Planned'].includes(p.status)||!isoDay(p.date)||p.date<'2026-01-01'||p.date>(data.through>'2027-01-15'?data.through:'2027-01-15')) fail('invalid payment type, jurisdiction, date or status.');
    if((p.date>data.through)!==(p.status==='Planned')) fail('Paid must be on/before cutoff; Planned must be after cutoff.');
    if(p.kind==='Withholding'&&(p.status!=='Paid'||!p.date.startsWith('2026-'))) fail('enter future withholding only in Remaining federal withholding.');
    if(p.kind==='Prior-year credit'&&p.status!=='Paid') fail('prior-year credits must be confirmed with their effective dates.');
    const value=amount(p.amount,'payment');if(value<=0) fail('payments must be positive.');
    return {id:p.id,jurisdiction:p.jurisdiction,kind:p.kind,date:p.date,amount:value,status:p.status};
  });
  for(const [jurisdiction,key] of [['Federal','federalTaxPaid'],['State','stateTaxPaid']]) {
    const total=payments.filter(p=>p.jurisdiction===jurisdiction&&p.status==='Paid').reduce((s,p)=>s+cents(p.amount),0);
    if(total!==cents(amount(ytd.household?.[key],key))) fail(`${jurisdiction} paid ledger does not reconcile to YTD; include applied credits and exclude future payments/FICA.`);
  }
  if(data.through>'2026-12-31'&&data.remainingWithholding!==0) fail('remaining 2026 withholding must be zero after year end.');
  return {...data,priorYearAgi,priorYearTax,payments,projectedFederalTax:amount(data.projectedFederalTax,'projected federal tax'),
    remainingWithholding:amount(data.remainingWithholding,'remaining withholding')};
}

export function federalEstimatedTaxLiability(taxes) {
  // Includes income tax after refundable credits, NIIT, SE, Additional Medicare,
  // and the model's additional early-distribution taxes. Regular employee FICA
  // and state tax are separate payment channels.
  const value=taxes.totalTax-(taxes.employeePayrollTax??0)-(taxes.spouseEmployeePayrollTax??0)-(taxes.stateTax??0);
  return amount(Math.max(0,value),'modeled federal liability');
}

export function calculateQuarterlyTax(plan,projectedTax=plan.projectedFederalTax) {
  const tax=cents(amount(projectedTax,'projected federal tax'));
  const federal=plan.payments.filter(p=>p.jurisdiction==='Federal');
  const withholding=federal.filter(p=>p.kind==='Withholding').reduce((s,p)=>s+cents(p.amount),0);
  const forecastWh=withholding+cents(plan.remainingWithholding);
  const estimates=federal.filter(p=>p.kind!=='Withholding');
  const sum=(status,due='9999-12-31')=>estimates.filter(p=>p.status===status&&p.date<=due).reduce((s,p)=>s+cents(p.amount),0);
  const actual=sum('Paid'),planned=sum('Planned');
  const current=Math.floor((tax*90+50)/100);
  const multiplier=plan.priorYearMethod==='Full-year return'&&plan.priorYearAgi>(plan.filingStatus==='marriedFilingSeparately'?75000:150000)?110:100;
  const prior=plan.priorYearMethod!=='Unavailable'?Math.floor((cents(plan.priorYearTax)*multiplier+50)/100):null;
  const target=prior==null?current:Math.min(current,prior);
  let basis=prior!=null&&prior<=current?`Prior-year ${multiplier}%`:'Projected current-year 90%';
  if(plan.priorYearMethod==='No-tax exception') basis='Reviewed prior-year no-tax exception';
  const recordedTarget=tax-withholding<100000?0:target;
  const forecastTarget=tax-forecastWh<100000?0:target;
  if(forecastTarget===0&&target>0) basis='Projected balance after withholding below $1,000';
  const fraction=(total,q)=>Math.floor((total*q+2)/4),dollars=v=>v/100;
  const quarters=QUARTERLY_DUE_DATES.map((due,i)=>{
    const q=i+1,recordedCoverage=fraction(withholding,q)+sum('Paid',due);
    const forecastCoverage=fraction(forecastWh,q)+sum('Paid',due)+sum('Planned',due);
    return {quarter:q,dueDate:due,pastDue:due<plan.through,recordedCumulativeTarget:dollars(fraction(recordedTarget,q)),cumulativeTarget:dollars(fraction(forecastTarget,q)),
      recordedCoverage:dollars(recordedCoverage),forecastCoverage:dollars(forecastCoverage),
      recordedGap:dollars(Math.max(0,fraction(recordedTarget,q)-recordedCoverage)),
      forecastGap:dollars(Math.max(0,fraction(forecastTarget,q)-forecastCoverage))};
  });
  const dueCount=QUARTERLY_DUE_DATES.filter(d=>d<=plan.through).length;
  const next=quarters.find(r=>r.dueDate>=plan.through);
  return {taxYear:2026,through:plan.through,projectedFederalTax:dollars(tax),sheetProjectedFederalTax:plan.projectedFederalTax,
    currentYearTarget:dollars(current),priorYearTarget:prior==null?null:dollars(prior),priorYearMultiplier:multiplier,
    annualTarget:dollars(forecastTarget),basis,recordedWithholding:dollars(withholding),projectedWithholding:dollars(forecastWh),
    paidEstimatesAndCredits:dollars(actual),plannedEstimates:dollars(planned),balanceAfterRecordedPayments:dollars(tax-withholding-actual),
    balanceAfterPlannedPayments:dollars(tax-forecastWh-actual-planned),remainingSafeHarbor:dollars(Math.max(0,forecastTarget-forecastWh-actual-planned)),
    catchUpRecorded:dollars(Math.max(0,fraction(recordedTarget,dueCount)-fraction(withholding,dueCount)-actual)),
    catchUpForecast:dollars(Math.max(0,fraction(forecastTarget,dueCount)-fraction(forecastWh,dueCount)-actual)),
    nextDueDate:next?.dueDate??null,nextAdditionalPayment:next?.forecastGap??0,quarters};
}
