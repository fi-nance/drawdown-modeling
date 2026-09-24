const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=value=>value==null?'Unavailable':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(value);

export function quarterlyTaxHtml(plan) {
  if(!plan) return '';
  if(plan.unavailable) return `<p class="assumption-note">Quarterly plan unavailable: ${esc(plan.unavailable)}</p>`;
  return `<section class="quarterly-tax-plan" aria-label="Federal quarterly tax plan">
    <h4>2026 federal quarterly estimates</h4>
    <p>As of ${esc(plan.through)} · regular installments · selected simulation path. Projected full-year federal tax: <strong>${money(plan.projectedFederalTax)}</strong> (spreadsheet forecast: ${money(plan.sheetProjectedFederalTax)}).</p>
    <p>90% current-year target: ${money(plan.currentYearTarget)} · prior-year target: ${money(plan.priorYearTarget)}. Selected annual prepayment target: <strong>${money(plan.annualTarget)}</strong> · ${esc(plan.basis)}.</p>
    <p>Next due: <strong>${esc(plan.nextDueDate??'None')}</strong> · additional payment under this forecast: <strong>${money(plan.nextAdditionalPayment)}</strong>. Catch-up through cutoff using recorded withholding: ${money(plan.catchUpRecorded)}; using projected withholding: ${money(plan.catchUpForecast)}. These amounts overlap; do not add them.</p>
    <div class="monarch-table-scroll"><table><caption>Cumulative targets and coverage at each due date</caption><thead><tr><th>Due date</th><th>Recorded target</th><th>Forecast target</th><th>Recorded coverage</th><th>Forecast coverage</th><th>Recorded gap</th><th>Forecast gap</th></tr></thead><tbody>
    ${plan.quarters.map(q=>`<tr><td>${esc(q.dueDate)}${q.pastDue?' · past due':''}</td><td>${money(q.recordedCumulativeTarget)}</td><td>${money(q.cumulativeTarget)}</td><td>${money(q.recordedCoverage)}</td><td>${money(q.forecastCoverage)}</td><td>${money(q.recordedGap)}</td><td>${money(q.forecastGap)}</td></tr>`).join('')}
    </tbody></table></div>
    <p>Withholding recorded ${money(plan.recordedWithholding)} / projected ${money(plan.projectedWithholding)}. Estimates and applied credits paid ${money(plan.paidEstimatesAndCredits)} / planned estimates ${money(plan.plannedEstimates)}. Additional annual safe-harbor funding: ${money(plan.remainingSafeHarbor)}.</p>
    <p>Federal balance after recorded payments: ${money(plan.balanceAfterRecordedPayments)}; projected filing balance after all plans: <strong>${money(plan.balanceAfterPlannedPayments)}</strong>. Negative balances are potential credits/refunds, not available spending money. Safe-harbor funding can leave tax due at filing.</p>
    <p class="assumption-note">Withholding is allocated evenly to four due dates. Forecast coverage includes future withholding and planned estimates; it is not proof of payment. Recorded gaps assume no further withholding (including the $1,000 test). Late estimates reduce today's catch-up but do not erase earlier timing gaps. This panel plans timing; the simulation still reserves its full remaining tax liability and does not debit these targets again. State/local rules, Schedule AI for uneven income, disaster relief and penalty amounts are not calculated. Review the <a href="https://www.irs.gov/pub/irs-pdf/f1040es.pdf" target="_blank" rel="noopener noreferrer">2026 IRS instructions</a>.</p>
  </section>`;
}

export function quarterlyPreview(plan) {
  if(!plan) return '';
  return `<h4>Federal quarterly planning enabled</h4><p>2026 regular installments; ${esc(plan.payments.length)} dated payment records. Prior-year method: ${esc(plan.priorYearMethod)}. Remaining federal withholding: ${money(plan.remainingWithholding)}. The spreadsheet forecast is ${money(plan.projectedFederalTax)}; running the model recalculates targets from its full-year federal liability. State payments stay separate. Future plans are not treated as paid. Review the first-year quarterly table after running the model.</p>`;
}
