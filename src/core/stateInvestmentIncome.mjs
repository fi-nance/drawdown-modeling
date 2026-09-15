export function stateTaxesHsa(state) {
  return ['California', 'CA', 'New Jersey', 'NJ'].includes(state);
}

// These are security gains, not HSA distribution proceeds. Account principal
// has already been taxed by the nonconforming state.
export function hsaCapitalEvents(sales = []) {
  return sales.filter(sale => sale.accountType === 'hsa').map(sale => ({
    owner: sale.owner ?? 'primary', accountType: 'taxable',
    gain: Number(sale.hsaCapitalGain) || 0,
    taxType: sale.holdingPeriod === 'short' ? 'short' : 'long'
  }));
}

export function hsaCapitalTotals(sales = []) {
  return hsaCapitalEvents(sales).reduce((total, event) => {
    total[event.taxType === 'short' ? 'shortTerm' : 'longTerm'] += event.gain;
    return total;
  }, {shortTerm:0, longTerm:0});
}

export function stateExemptInterestShare(asset) {
  // Explicit custodian-confirmed qualifying interest fraction. Never infer
  // Treasury eligibility from a generic bond/cash label or exempt sale gains.
  return Math.max(0, Math.min(1, Number(asset.stateExemptInterestShare) || 0));
}
