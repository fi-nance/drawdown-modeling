import { parseMonarchPortfolio, previewMonarchImport } from './core/monarchImport.mjs';
import { quarterlyPreview } from './quarterlyTaxUI.mjs';
const esc = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = value => value==null?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(value);

export function attachMonarchImport({ readAssets, apply, isBusy, reportError }) {
  const input=document.querySelector('#monarchFile'), panel=document.querySelector('#monarchPreview');
  let pending=null, sequence=0;
  const clear=()=>{ pending=null; panel.hidden=true; panel.replaceChildren(); input.value=''; sequence++; };
  function stage(raw) {
    clear();
    const bundle=parseMonarchPortfolio(raw), before=JSON.stringify(readAssets());
    const review=previewMonarchImport(readAssets(),bundle);
    pending={raw,bundle,before};
    const counts=Object.fromEntries(['Added','Changed','Removed','Unchanged'].map(k=>[k,review.changes.filter(r=>r.change===k).length]));
    const changes=[...review.changes].sort((a,b)=>['Removed','Changed','Added','Unchanged'].indexOf(a.change)-['Removed','Changed','Added','Unchanged'].indexOf(b.change));
    panel.innerHTML=`<h4>Review Monarch portfolio</h4>
      <p>As of <strong>${esc(bundle.provenance.asOfDate)}</strong> · ${review.assets.length} lots/holdings · ${bundle.accounts.length} accounts</p>
      <p>Current ${money(review.beforeTotal)} → Imported <strong>${money(review.total)}</strong></p>
      <p>${counts.Added} added · ${counts.Changed} changed · ${counts.Removed} removed · ${counts.Unchanged} unchanged</p>
      <p>This replaces all current holdings. Spending, healthcare, income streams and retirement-history controls stay as entered. Review Roth conversion/contribution history, IRA basis and HSA receipts separately.</p>
      ${bundle.provenance.yearToDate?ytdPreview(bundle.provenance.yearToDate):'<p>These are opening balances for annual projections. This portfolio-only file has no YTD activity. Future yield and qualified-share values are planning assumptions.</p>'}
      <div class="monarch-table-scroll"><table><caption>Included account reconciliation</caption><thead><tr><th>Account</th><th>Type / owner</th><th>Balance</th><th>Additional cash</th></tr></thead><tbody>
      ${bundle.accounts.map(a=>`<tr><td>${esc(a.name)}</td><td>${esc(a.accountSubtype)} / ${esc(a.owner)}</td><td>${money(a.exportedValue)}</td><td>${money(a.additionalCash)}</td></tr>`).join('')}
      </tbody></table></div>
      ${bundle.excludedAccounts.length?`<details><summary>${bundle.excludedAccounts.length} explicitly excluded accounts</summary><ul>${bundle.excludedAccounts.map(a=>`<li>${esc(a.name)}: ${esc(a.reason)}</li>`).join('')}</ul></details>`:''}
      <details open><summary>Holding changes${changes.length>200?' (first 200; removals first)':''}</summary>
      <div class="monarch-table-scroll"><table><thead><tr><th>Change</th><th>Holding</th><th>Before</th><th>After</th><th>Changed fields</th></tr></thead><tbody>
      ${changes.slice(0,200).map(a=>`<tr><td>${esc(a.change)}</td><td>${esc(a.name)}<br><small>${esc(a.id)}</small></td><td>${money(a.before)}</td><td>${money(a.after)}</td><td>${esc(a.fields.join(', '))}</td></tr>`).join('')}
      </tbody></table></div></details>
      <details><summary>Source and review notes</summary><p>Export ${esc(bundle.provenance.exportId)} · source ${esc(bundle.provenance.sourceExportedAt)}</p>
      <ul>${bundle.warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul></details>
      <label class="check-row"><input id="monarchReviewed" type="checkbox"><span>I reviewed the replacements, exclusions and retirement-history inputs.</span></label>
      <div class="button-row"><button id="applyMonarch" type="button" disabled>Apply reviewed portfolio</button><button id="cancelMonarch" class="ghost-button" type="button">Cancel</button></div>`;
    panel.hidden=false;
    panel.querySelector('#monarchReviewed').addEventListener('change',e=>{panel.querySelector('#applyMonarch').disabled=!e.target.checked;});
    panel.querySelector('#cancelMonarch').addEventListener('click',clear);
    panel.querySelector('#applyMonarch').addEventListener('click',()=>{
      try {
        if(!pending || !panel.querySelector('#monarchReviewed').checked) return;
        if(isBusy()) throw new Error('Wait for the current simulation or price refresh to finish before importing.');
        if(JSON.stringify(readAssets())!==pending.before) throw new Error('The current holdings changed. Select the file again to refresh the preview.');
        const fresh=parseMonarchPortfolio(pending.raw), reviewed=previewMonarchImport(readAssets(),fresh);
        apply(reviewed.assets,{...fresh.provenance,importedAt:new Date().toISOString()});
        clear();
      } catch(error) { reportError(error); }
    });
    panel.scrollIntoView({behavior:'smooth',block:'start'});
  }
  input.addEventListener('change',async()=>{
    const file=input.files?.[0];clear();
    if(!file) return;
    const request=sequence;
    try {
      if(file.size>12*1024*1024) throw new Error('Monarch export exceeds the 12 MiB limit.');
      const raw=await file.text();
      if(request===sequence) stage(raw);
    } catch(error){reportError(error);}
  });
  return {stage,clear};
}

function ytdPreview(ytd) {
  const h=ytd.household;
  return `${quarterlyPreview(ytd.quarterlyTax)}<h4>Year-to-date through ${esc(ytd.through)}</h4>
    <p>${ytd.dividendRecordCount} distribution records · ${ytd.saleLotCount} sold lots. Past receipts and proceeds affect annual taxes only; they are already reflected in the opening balances.</p>
    <div class="monarch-table-scroll"><table><thead><tr><th>Account / tax treatment</th><th>Ordinary dividends<br>(includes qualified)</th><th>Qualified portion</th><th>ST net</th><th>LT net + distributions</th></tr></thead><tbody>
    ${ytd.accounts.map(a=>`<tr><td>${esc(a.name)} / ${esc(a.taxBucket)}</td><td>${money(a.ordinaryDividends)}</td><td>${money(a.qualifiedDividends)}</td><td>${money(a.shortTermGains-a.shortTermLosses)}</td><td>${money(a.longTermGains-a.longTermLosses+a.capitalGainDistributions)}</td></tr>`).join('')}
    </tbody></table></div>
    <p>Remaining living spending: <strong>${money(h.remainingSpending)}</strong>. Remaining healthcare: ${money(h.remainingMedical)}. Taxes already paid: ${money(h.federalTaxPaid+h.stateTaxPaid+h.payrollTaxPaid)}.</p>
    <p>Applying this file enables a partial first year. Reviewed remaining wages, Social Security, spending, healthcare and RMDs replace year-one annual inputs. Yields, returns, fees and recurring streams cover remaining days only. Scheduled year-one one-offs and tax strategies must represent future activity. Later years resume annual settings.</p>
    <p>Provisional classifications remain estimates. This mode does not reconcile past retirement/HSA distributions or contributions, Roth conversions, tax-exempt income, or ACA premium credits. Refunds are reported, not reinvested. Edit Drawdown YTD in the spreadsheet and re-export to update the actuals or remaining budgets.</p>`;
}
