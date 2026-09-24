export function isoDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Lot dates must use YYYY-MM-DD.');
  const day = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0,10) !== value || value < '1900-01-01') throw new Error('Invalid lot date.');
  return day;
}
export function shiftDayYear(value, years) {
  const original=isoDay(value), year=original.getUTCFullYear()+years, month=original.getUTCMonth();
  const day=Math.min(original.getUTCDate(),new Date(Date.UTC(year,month+1,0)).getUTCDate());
  return new Date(Date.UTC(year,month,day)).toISOString().slice(0,10);
}
export function termOnDate(acquired, asOf) {
  const first=isoDay(acquired), last=isoDay(asOf);
  if(first>last) throw new Error('Acquisition date is after valuation date.');
  return last>isoDay(shiftDayYear(acquired,1))?'long':'short';
}
