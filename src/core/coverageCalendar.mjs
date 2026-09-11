// Explicit enrollment/eligibility facts; no employer-affordability or Medicaid
// eligibility inference is made from income alone.
export function parseCoverageCalendar(text) {
  if (!String(text ?? '').trim()) return [];
  const seen = new Set();
  return String(text).trim().split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    const [member, yearText, firstText, lastText, eligibility, benchmarkText, premiumText, ...extra] = line.split(',').map(value => value.trim());
    const [year, firstMonth, lastMonth, monthlyBenchmark, monthlyPremium] = [yearText, firstText, lastText, benchmarkText, premiumText].map(Number);
    if (extra.length || !member || !/^\d{4}$/.test(yearText ?? '') || !Number.isInteger(firstMonth) || !Number.isInteger(lastMonth) || firstMonth < 1 || lastMonth > 12 || firstMonth > lastMonth || !['eligible','employer','medicaid','dependent','unknown'].includes(eligibility) || !benchmarkText || !premiumText || !Number.isFinite(monthlyBenchmark) || !Number.isFinite(monthlyPremium) || monthlyBenchmark < 0 || monthlyPremium < 0) {
      throw new Error(`Coverage calendar line ${index + 1}: enter member, year, first month, last month, eligibility, monthly benchmark, monthly plan premium.`);
    }
    for (let month = firstMonth; month <= lastMonth; month++) {
      const key = `${member}/${year}/${month}`;
      if (seen.has(key)) throw new Error(`Coverage calendar overlaps for ${member} in ${year}, month ${month}.`);
      seen.add(key);
    }
    return { member, year, firstMonth, lastMonth, eligibility, monthlyBenchmark, monthlyPremium };
  });
}
