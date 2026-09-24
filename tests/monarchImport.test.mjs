import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMonarchPortfolio, previewMonarchImport, isMonarchPortfolio } from '../src/core/monarchImport.mjs';
import { termOnDate } from '../src/core/lotDates.mjs';
import { ageHoldingPeriods, harvestTaxLosses } from '../src/core/portfolio.mjs';
import { parsePortfolioJson } from '../src/core/importers.mjs';
import { createSetupBackup, parseSetupBackup } from '../src/core/setupBackup.mjs';

const today='2026-09-22';
function fixture() {
  const accounts=['taxable','traditional','roth','hsa'].map((accountType,i)=>({accountId:`fictional-${i}`,name:`Example ${accountType}`,
    accountType,accountSubtype:['brokerage','traditionalIra','rothIra','hsa'][i],owner:'primary',reportedBalance:1500,holdingsValue:1500,additionalCash:0,exportedValue:1500}));
  return {type:'monarch-drawdown-portfolio',schemaVersion:1,exportId:'a'.repeat(32),exportedAt:'2026-09-22T10:00:00Z',
    sourceExportedAt:'2026-09-22T00:00:00Z',reviewedSourceExportedAt:'2026-09-22T00:00:00Z',asOfDate:today,currency:'USD',maximumAgeDays:7,
    accounts,excludedAccounts:[],warnings:['Fictional fixture only.'],assets:accounts.map((a,i)=>({id:`lot-${i}`,name:'Example fund',symbol:'DEMO',
      accountId:a.accountId,accountType:a.accountType,accountSubtype:a.accountSubtype,owner:a.owner,assetClass:'stock',
      units:10,price:150,costBasisPerUnit:['taxable','hsa'].includes(a.accountType)?120:null,
      acquiredDate:['taxable','hsa'].includes(a.accountType)?'2026-01-01':null,holdingPeriod:['taxable','hsa'].includes(a.accountType)?'short':'unknown',
      valuationDate:today,dividendYield:.02,qualifiedDividendShare:.8,stateExemptInterestShare:0}))};
}
const parse=data=>parseMonarchPortfolio(JSON.stringify(data),{today});

test('strict bridge accepts all four types without inventing sheltered security basis',()=>{
  const result=parse(fixture());assert.equal(result.assets.length,4);
  assert.equal(result.assets[1].costBasisPerUnit,null);
  assert.equal(result.assets[1].holdingPeriod,'unknown');
  assert.equal(result.assets[0].costBasisPerUnit,120);
  assert.equal(result.provenance.asOfDate,today);
  assert.equal(isMonarchPortfolio(JSON.stringify(fixture())),true);
  assert.throws(()=>parsePortfolioJson(JSON.stringify(fixture())),/preview/);
});
test('basis, acquisition date and future assumptions cannot fall through to generic defaults',()=>{
  for(const field of ['costBasisPerUnit','acquiredDate','dividendYield','qualifiedDividendShare','stateExemptInterestShare']) {
    const data=fixture();delete data.assets[0][field];assert.throws(()=>parse(data));
  }
  const data=fixture();data.assets[0].costBasisPerUnit=0;
  data.assets[0].qualifiedDividendShare=0;assert.equal(parse(data).assets[0].costBasisPerUnit,0);
});
test('schema, stale date, currency, mismatch and duplicate checks reject partial imports',()=>{
  for(const mutate of [d=>d.schemaVersion=2,d=>d.currency='EUR',d=>d.reviewedSourceExportedAt='',
    d=>d.assets[0].units=11,d=>d.assets[0].price='150',d=>d.assets[0].holdingPeriod='long',
    d=>d.assets[1].id=d.assets[0].id,d=>d.accounts[0].accountSubtype='traditionalIra',
    d=>d.accounts[1].owner='joint',d=>d.assets[0].assetClass='ETF',d=>d.assets.pop(),
    d=>d.excludedAccounts.push({accountId:d.accounts[0].accountId,name:'Example',reason:'Overlap'})]) {
    const data=fixture();mutate(data);assert.throws(()=>parse(data));
  }
  assert.throws(()=>parseMonarchPortfolio(JSON.stringify(fixture()),{today:'2026-10-01'}),/stale/);
  assert.throws(()=>parseMonarchPortfolio(JSON.stringify(fixture()),{today:'2026-09-21'}),/future/);
});
test('cash basis validation and unsupported Roth employer account checks',()=>{
  const data=fixture();data.assets[0].assetClass='cash';assert.throws(()=>parse(data),/cash basis/);
  data.assets[0].costBasisPerUnit=150;assert.equal(parse(data).assets[0].holdingPeriod,'long');
  data.accounts[2].accountSubtype='roth401k';data.assets[2].accountSubtype='roth401k';assert.throws(()=>parse(data),/employer/);
});
test('preview exposes additions, removals and changed fields, preserving planner account assumptions',()=>{
  const bundle=parse(fixture()), old=structuredClone(bundle.assets);
  old[0].units=12;old[0].beneficiaryType='spouse';old[1].nondeductibleBasis=200;
  old[2].id='replaced-roth-lot';old.push({...old[0],id:'outside-plan'});
  const before=JSON.stringify(old),review=previewMonarchImport(old,bundle);
  assert.equal(JSON.stringify(old),before);
  assert.equal(review.assets[0].beneficiaryType,'spouse');
  assert.equal(review.assets[1].nondeductibleBasis,200);
  assert.equal(review.total,6000);
  assert.equal(review.changes.filter(a=>a.change==='Removed').length,2);
  assert.equal(review.changes.filter(a=>a.change==='Added').length,1);
  assert.deepEqual(review.changes[0].fields,['units']);
});
test('conflicting saved account assumptions and legacy conversion history require reconciliation',()=>{
  const bundle=parse(fixture()),old=structuredClone(bundle.assets);
  old[0].beneficiaryType='spouse';old.push({...old[0],id:'another',beneficiaryType:'nonSpouse10Yr'});
  assert.throws(()=>previewMonarchImport(old,bundle),/conflicting/);
  old.pop();old[2].rothSource='conversion';assert.throws(()=>previewMonarchImport(old,bundle),/conversion/);
  delete old[2].accountId;assert.throws(()=>previewMonarchImport(old,bundle),/conversion/);
  delete old[2].rothSource;old[1].nondeductibleBasis=200;delete old[1].accountId;
  assert.throws(()=>previewMonarchImport(old,bundle),/unmatched account/);
});
test('date boundary, leap anniversary and annual aging retain acquisition semantics',()=>{
  assert.equal(termOnDate('2025-09-22',today),'short');
  assert.equal(termOnDate('2025-09-21',today),'long');
  assert.equal(termOnDate('2024-02-29','2025-02-28'),'short');
  assert.equal(termOnDate('2024-02-29','2025-03-01'),'long');
  assert.throws(()=>termOnDate('2026-02-30',today));
  const assets=parse(fixture()).assets;
  ageHoldingPeriods(assets,2026,{yearIndex:0});assert.equal(assets[0].holdingPeriod,'short');
  ageHoldingPeriods(assets,2027,{yearIndex:1});assert.equal(assets[0].holdingPeriod,'long');
});
test('harvested lots use reset year instead of aging from their original imported date',()=>{
  const a={...parse(fixture()).assets[0],acquiredDate:'2020-01-01',holdingPeriod:'long',price:100};
  harvestTaxLosses([a],1000,{calendarYear:2026});
  ageHoldingPeriods([a],2026,{yearIndex:0});assert.equal(a.holdingPeriod,'short');
  ageHoldingPeriods([a],2027,{yearIndex:1});assert.equal(a.holdingPeriod,'long');assert.equal(a.acquiredDate,undefined);
});
test('setup roundtrip preserves provenance, acquisition dates and all household controls',()=>{
  const b=parse(fixture());const state={assets:b.assets,controls:{targetSpend:50000,rothBasis:30000,rothConversionHistory:'example'},portfolioImport:b.provenance};
  const restored=parseSetupBackup(JSON.stringify(createSetupBackup(state)));
  assert.deepEqual(restored.controls,state.controls);assert.deepEqual(restored.portfolioImport,b.provenance);
  assert.equal(restored.assets[0].acquiredDate,'2026-01-01');
  const generic=parsePortfolioJson(JSON.stringify(b.assets));
  assert.equal(generic[0].acquiredDate,'2026-01-01');assert.equal(generic[1].costBasisPerUnit,null);
});
