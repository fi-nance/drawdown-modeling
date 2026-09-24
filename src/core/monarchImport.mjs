// Strict bridge contract. Never send this data over the network or infer missing tax inputs.
import { ACCOUNT_SUBTYPES } from './iraBasis.mjs';
import { isoDay, termOnDate } from './lotDates.mjs';
import { validateYearToDate } from './yearToDate.mjs';
export const MONARCH_PORTFOLIO_TYPE = 'monarch-drawdown-portfolio';
const classes = new Set(['stock','bond','cash','realEstate','tips','crypto']);
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const fail = message => { throw new Error(`Monarch export: ${message}`); };
const text = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) fail(`${label} is missing or invalid.`);
  return value;
};
const finite = (value, label, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${label} is missing or invalid.`);
  return value;
};
export function isMonarchPortfolio(textValue) {
  try { return JSON.parse(textValue)?.type === MONARCH_PORTFOLIO_TYPE; } catch { return false; }
}
export function parseMonarchPortfolio(raw, { today = new Date().toISOString().slice(0,10) } = {}) {
  if (typeof raw !== 'string' || raw.length > 12*1024*1024) fail('file is too large.');
  let data;
  try { data=JSON.parse(raw); } catch { fail('invalid JSON.'); }
  if (data?.type !== MONARCH_PORTFOLIO_TYPE || ![1,2].includes(data.schemaVersion)) fail('unsupported file type or version.');
  if(data.schemaVersion===1 && data.yearToDate!=null) fail('year-to-date history requires schema version 2.');
  if (data.currency !== 'USD') fail('only USD portfolios are supported.');
  const day = isoDay(data.asOfDate), now = isoDay(today);
  const maxAge = finite(data.maximumAgeDays,'maximum age',1,30);
  if (!Number.isInteger(maxAge) || day > now || (now-day)/86400000 > maxAge) fail('source is stale or future-dated. Refresh and review it again.');
  for (const field of ['exportId','exportedAt','sourceExportedAt']) text(data[field],field);
  if (!/^[a-f0-9]{32}$/.test(data.exportId)) fail('invalid export identity.');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(data.sourceExportedAt)
    || !Number.isFinite(Date.parse(data.sourceExportedAt)) || !Number.isFinite(Date.parse(data.exportedAt))
    || Date.parse(data.exportedAt)<Date.parse(data.sourceExportedAt)
    || data.sourceExportedAt.slice(0,10) !== data.asOfDate || data.reviewedSourceExportedAt !== data.sourceExportedAt) fail('source review/timestamps do not match.');
  if (!Array.isArray(data.accounts) || !data.accounts.length || !Array.isArray(data.assets) || !data.assets.length || data.assets.length>50000) fail('accounts/holdings are missing or exceed limits.');
  const accounts = new Map();
  for (const a of data.accounts) {
    if (!a || typeof a !== 'object') fail('invalid account.');
    text(a.accountId,'account ID'); text(a.name,'account name');
    if (accounts.has(a.accountId)) fail('duplicate account IDs.');
    if (!own(ACCOUNT_SUBTYPES,a.accountType) || !ACCOUNT_SUBTYPES[a.accountType].includes(a.accountSubtype)) fail('invalid account tax treatment/subtype.');
    if (!['primary','spouse','joint'].includes(a.owner) || a.owner === 'joint' && a.accountType !== 'taxable') fail('invalid account owner.');
    if (['roth401k','roth403b'].includes(a.accountSubtype)) fail('unrolled Roth employer plans are unsupported.');
    for (const key of ['reportedBalance','holdingsValue','additionalCash','exportedValue']) finite(a[key],key);
    if (Math.abs(a.holdingsValue+a.additionalCash-a.reportedBalance)>.050001 || Math.abs(a.exportedValue-a.reportedBalance)>.050001) fail('account balance reconciliation failed.');
    accounts.set(a.accountId,{accountId:a.accountId,name:a.name,accountType:a.accountType,accountSubtype:a.accountSubtype,owner:a.owner,
      reportedBalance:a.reportedBalance,holdingsValue:a.holdingsValue,additionalCash:a.additionalCash,exportedValue:a.exportedValue});
  }
  const seen = new Set(), totals = new Map();
  const assets = data.assets.map(a => {
    if (!a || typeof a !== 'object') fail('invalid holding.');
    const id = text(a.id,'lot/holding ID'), name = text(a.name,'holding name'), account = accounts.get(a.accountId);
    if (seen.has(id)) fail('duplicate lot/holding IDs.');
    seen.add(id);
    if (!account || ['accountType','accountSubtype','owner'].some(k=>a[k]!==account[k])) fail('holding account metadata conflicts.');
    if (!classes.has(a.assetClass) || a.valuationDate !== data.asOfDate) fail('investment class or valuation date is invalid.');
    const units=finite(a.units,'units',Number.MIN_VALUE), price=finite(a.price,'price',Number.MIN_VALUE);
    finite(units*price,'holding value');
    const basis=a.costBasisPerUnit == null ? null : finite(a.costBasisPerUnit,'basis');
    const taxSensitive=['taxable','hsa'].includes(a.accountType);
    if (taxSensitive && basis === null) fail('taxable/HSA basis is missing; market-price defaults are forbidden.');
    let acquiredDate=null, holdingPeriod='unknown';
    if (a.assetClass === 'cash') {
      if (taxSensitive && Math.abs(basis*units-price*units)>.050001) fail('cash basis must match value.');
      holdingPeriod='long';
    } else if (taxSensitive || a.acquiredDate != null) {
      acquiredDate=text(a.acquiredDate,'acquisition date');
      holdingPeriod=termOnDate(acquiredDate,data.asOfDate);
      if (a.holdingPeriod !== holdingPeriod) fail('holding period conflicts with the acquisition date.');
    }
    totals.set(a.accountId,(totals.get(a.accountId)||0)+units*price);
    return {id,name,symbol:typeof a.symbol==='string'?a.symbol.slice(0,100):'',accountId:a.accountId,
      accountType:a.accountType,accountSubtype:a.accountSubtype,owner:a.owner,assetClass:a.assetClass,units,price,
      costBasisPerUnit:basis,acquiredDate,holdingPeriod,valuationDate:data.asOfDate,
      dividendYield:finite(a.dividendYield,'future income yield',0,1),
      qualifiedDividendShare:finite(a.qualifiedDividendShare,'future qualified share',0,1),
      stateExemptInterestShare:finite(a.stateExemptInterestShare,'state-exempt interest share',0,1),
      monarchExportId:data.exportId,beneficiaryType:'default'};
  });
  for (const a of accounts.values()) if (Math.abs((totals.get(a.accountId)||0)-a.reportedBalance)>.050001) fail('holding rows do not reconcile to an account balance.');
  if (!Array.isArray(data.excludedAccounts) || !Array.isArray(data.warnings)) fail('coverage information missing.');
  const excludedAccounts=data.excludedAccounts.map(a=>{
    text(a?.accountId,'excluded account ID'); text(a?.reason,'exclusion reason'); text(a?.name,'excluded account name');
    if (accounts.has(a.accountId)) fail('account is both included and excluded.');
    return {accountId:a.accountId,name:a.name,reason:a.reason};
  });
  if (new Set(excludedAccounts.map(a=>a.accountId)).size!==excludedAccounts.length) fail('duplicate excluded account IDs.');
  return {assets, accounts:[...accounts.values()],excludedAccounts,
    warnings:data.warnings.map(w=>text(w,'review note')),
    provenance:{type:data.type,schemaVersion:data.schemaVersion,exportId:data.exportId,exportedAt:data.exportedAt,
      ...(data.schemaVersion===2?{yearToDate:validateYearToDate(data.yearToDate,data),yearToDateEnabled:true}:{}),
      sourceExportedAt:data.sourceExportedAt,asOfDate:data.asOfDate,currency:'USD'}};
}

const preservedFields=['beneficiaryType','beneficiaryId','beneficiaryAge','nondeductibleBasis','rolloverToIraAtStart'];
export function previewMonarchImport(current, bundle) {
  const old=new Map(current.map(a=>[a.id,a])), incoming=new Set(bundle.assets.map(a=>a.id));
  if (current.some(a=>a.rothSource==='conversion')) fail('move legacy conversion-tagged holdings into explicit remaining Roth conversion history, then remove the legacy tags before importing.');
  const incomingAccounts=new Set(bundle.accounts.map(a=>a.accountId));
  if (current.some(a=>Number(a.nondeductibleBasis)>0 && !incomingAccounts.has(a.accountId))) fail('saved IRA tax basis belongs to an unmatched account; transfer/reconcile it in the owner-level IRA basis controls before importing.');
  const byAccount=new Map();
  for (const a of current) if (a.accountId) {
    const list=byAccount.get(a.accountId)||[]; list.push(a); byAccount.set(a.accountId,list);
  }
  const assets=bundle.assets.map(a=>{
    const prior=old.get(a.id);
    const siblings=byAccount.get(a.accountId)||[];
    const retained={};
    for(const field of preservedFields) {
      const values=[...new Set(siblings.filter(s=>s.accountType===a.accountType && s.accountSubtype===a.accountSubtype)
        .map(s=>s[field]).filter(v=>v!=null))];
      if (values.length>1) fail(`conflicting saved account assumptions for ${field}; reconcile before importing.`);
      if (values.length===1) retained[field]=values[0];
      if (prior?.accountType===a.accountType && prior?.accountSubtype===a.accountSubtype && prior[field]!=null) retained[field]=prior[field];
    }
    return {...a,...retained};
  });
  const changes=[];
  for (const a of assets) {
    const prior=old.get(a.id);
    const keys=['units','price','costBasisPerUnit','accountType','accountSubtype','owner','assetClass','acquiredDate','holdingPeriod','dividendYield','qualifiedDividendShare','stateExemptInterestShare'];
    const fields=prior?keys.filter(k=>prior[k]!==a[k]):[];
    changes.push({id:a.id,name:a.name,accountId:a.accountId,change:!prior?'Added':fields.length?'Changed':'Unchanged',
      before:prior?prior.units*prior.price:null,after:a.units*a.price,fields});
  }
  for(const a of current) if(!incoming.has(a.id)) changes.push({id:a.id,name:a.name,accountId:a.accountId||'',change:'Removed',before:a.units*a.price,after:null,fields:[]});
  return {assets,changes,total:assets.reduce((s,a)=>s+a.units*a.price,0),
    beforeTotal:current.reduce((s,a)=>s+(a.units||0)*(a.price||0),0)};
}
