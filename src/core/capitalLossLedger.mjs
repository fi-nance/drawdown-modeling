import { normalizeLossCarryforward } from './simulation/income.mjs';
import { round } from './utils.mjs';

export function openingLossLedger(scenario) {
  return { primary:normalizeLossCarryforward(scenario.openingCapitalLossCarryforward),
    spouse:normalizeLossCarryforward(scenario.spouseOpeningCapitalLossCarryforward) };
}
export function totalLossLedger(ledger) {
  return Object.fromEntries(['shortTerm','longTerm'].map(term => [term, round(ledger.primary[term] + ledger.spouse[term],6)]));
}
// 26 CFR 1.1212-1(c)(1)(iv): allocate the remaining carryover by each
// spouse's individual net losses of the same character. Joint lots are 50/50.
export function advanceLossLedger(ledger, events, remaining, survivor = null) {
  const net = structuredClone(ledger);
  for (const event of events) {
    const term = event.taxType === 'ordinary' || event.taxType?.endsWith('short') ? 'shortTerm' : 'longTerm';
    const owners = survivor ? [[survivor,1]] : event.owner === 'joint' ? [['primary',0.5],['spouse',0.5]] : [[event.owner === 'spouse' ? 'spouse' : 'primary',1]];
    for (const [owner,share] of owners) net[owner][term] -= event.gain * share;
  }
  const result = {primary:{},spouse:{}};
  for (const term of ['shortTerm','longTerm']) {
    const primary = Math.max(0,net.primary[term]), spouse = Math.max(0,net.spouse[term]);
    const amount = Math.max(0,remaining[term] ?? 0);
    if (amount > 0.01 && primary + spouse <= 0) throw new Error('Capital-loss owner ledger does not reconcile with the tax carryforward.');
    result.primary[term] = round(amount * (primary + spouse > 0 ? primary / (primary + spouse) : 0),6);
    result.spouse[term] = round(amount - result.primary[term],6);
  }
  return result;
}
