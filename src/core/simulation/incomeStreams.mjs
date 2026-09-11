// First-class recurring income streams: pensions, annuities, rent, and other
// recurring income that the one-off cash-flow system cannot express well —
// age-based start/end on the OWNER's age clock, optional COLA, a survivor
// percentage that continues to the surviving spouse after the owner's death,
// tax character (ordinary vs tax-free), and state retirement-income
// eligibility (pensions/annuities default eligible so state IRA/pension
// exclusions apply; rent and other income default ineligible).
//
// Simplifications (documented in KNOWN_LIMITATIONS):
// - The survivor share starts the year after the owner's death (consistent
//   with the model's "death year is still filed jointly" rule) and is keyed
//   to the deceased owner's WOULD-BE age window — a survivor annuity on a
//   pension that had not yet started pays once the owner would have reached
//   the start age.
// - Tax-free streams (e.g. VA disability) are excluded from federal tax AND
//   from ACA MAGI, mirroring the one-off tax-free income type.
// - No FICA applies (pension/annuity/rent income is not earned income).

import { round } from "../utils.mjs";
import { mortalityStatus } from "./household.mjs";
import { optionalFiniteNumber } from "./guards.mjs";

export const INCOME_STREAM_TYPES = Object.freeze(["pension", "annuity", "rent", "other"]);

export function emptyStreamIncome() {
  return { cash: 0, ordinaryIncome: 0, retirementOrdinaryIncome: 0, ordinaryInvestmentIncome: 0, retirementIncomeDetails: [], taxFreeIncome: 0, details: [] };
}

export function normalizeIncomeStream(raw = {}, index = 0) {
  const type = INCOME_STREAM_TYPES.includes(raw.type) ? raw.type : "other";
  const startAge = optionalFiniteNumber(raw.startAge);
  const endAge = optionalFiniteNumber(raw.endAge);
  for (const [field, value] of [["start age", raw.startAge], ["end age", raw.endAge], ["annual amount", raw.annualAmount]]) {
    if (value != null && String(value).trim() !== "" && (optionalFiniteNumber(value) === null || Number(value) < 0)) {
      throw new RangeError(`Income stream ${index + 1}: ${field} must be a finite, nonnegative number or blank.`);
    }
  }
  if (endAge !== null && (endAge < 0 || (startAge !== null && endAge < startAge))) {
    throw new RangeError(`Income stream ${index + 1}: end age must be at or after start age, or blank for life.`);
  }
  return {
    id: raw.id ?? `income-stream-${index + 1}`,
    name: String(raw.name ?? "").trim() || streamTypeLabel(type),
    type,
    owner: raw.owner === "spouse" ? "spouse" : "primary",
    startAge,
    endAge,
    annualAmount: Math.max(0, Number(raw.annualAmount) || 0),
    inflationAdjusted: raw.inflationAdjusted !== false,
    survivorPercent: Math.max(0, Math.min(100, Number(raw.survivorPercent) || 0)),
    netInvestmentIncome: raw.netInvestmentIncome === true || (raw.netInvestmentIncome !== false && type === "rent"),
    taxCharacter: raw.taxCharacter === "taxFree" ? "taxFree" : "ordinary",
    // Pensions and annuities default to state retirement-income exclusion
    // eligibility; rent/other default out. Explicit true/false always wins.
    stateRetirementIncome: raw.stateRetirementIncome === true
      || (raw.stateRetirementIncome !== false && (type === "pension" || type === "annuity"))
  };
}

export function streamTypeLabel(type) {
  return {
    pension: "Pension",
    annuity: "Annuity",
    rent: "Rental income",
    other: "Recurring income"
  }[type] ?? "Recurring income";
}

export function incomeStreamsForYear({ scenario, yearIndex, inflationIndex = 1 }) {
  const rawStreams = Array.isArray(scenario?.incomeStreams) ? scenario.incomeStreams : [];
  if (!rawStreams.length) return emptyStreamIncome();

  const { primaryAge, spouseAge, primaryDeceased, spouseDeceased } = mortalityStatus(scenario, yearIndex);
  let cash = 0;
  let ordinaryIncome = 0;
  let retirementOrdinaryIncome = 0;
  let ordinaryInvestmentIncome = 0;
  const retirementIncomeDetails = [];
  let taxFreeIncome = 0;
  const details = [];

  rawStreams.forEach((raw, index) => {
    const stream = normalizeIncomeStream(raw, index);
    if (!(stream.annualAmount > 0) || stream.startAge === null) return;

    const ownerAge = stream.owner === "spouse" ? spouseAge : primaryAge;
    const ownerDeceased = stream.owner === "spouse" ? spouseDeceased : primaryDeceased;
    if (ownerAge === null) return; // spouse-owned stream with no spouse modeled
    if (ownerAge < stream.startAge) return;
    if (stream.endAge !== null && ownerAge > stream.endAge) return;

    let share = 1;
    let survivorShare = false;
    if (ownerDeceased) {
      const survivorAlive = stream.owner === "spouse"
        ? !primaryDeceased
        : (spouseAge !== null && !spouseDeceased);
      if (!survivorAlive || stream.survivorPercent <= 0) return;
      share = stream.survivorPercent / 100;
      survivorShare = true;
    }

    const amount = round(stream.annualAmount * share * (stream.inflationAdjusted ? Math.max(0, inflationIndex) : 1), 6);
    if (!(amount > 0)) return;

    cash += amount;
    if (stream.taxCharacter === "taxFree") {
      taxFreeIncome += amount;
    } else {
      ordinaryIncome += amount;
      if (stream.netInvestmentIncome) ordinaryInvestmentIncome += amount;
      if (stream.stateRetirementIncome) {
        retirementOrdinaryIncome += amount;
        retirementIncomeDetails.push({ owner: survivorShare ? (stream.owner === 'primary' ? 'spouse' : 'primary') : stream.owner, amount, type: stream.type });
      }
    }
    details.push({
      id: stream.id,
      name: stream.name,
      type: stream.type,
      owner: stream.owner,
      amount,
      taxCharacter: stream.taxCharacter,
      stateRetirementIncome: stream.stateRetirementIncome,
      survivorShare
    });
  });

  return {
    cash: round(cash, 6),
    ordinaryIncome: round(ordinaryIncome, 6),
    retirementOrdinaryIncome: round(retirementOrdinaryIncome, 6),
    ordinaryInvestmentIncome: round(ordinaryInvestmentIncome, 6),
    retirementIncomeDetails,
    taxFreeIncome: round(taxFreeIncome, 6),
    details
  };
}
