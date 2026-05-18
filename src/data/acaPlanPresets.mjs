export const MASSACHUSETTS_CONNECTORCARE_2026 = Object.freeze({
  year: 2026,
  source: "Massachusetts Health Connector 2026 ConnectorCare guide",
  fplGuideline: {
    base: 15650,
    increment: 5500
  },
  planTypes: [
    { name: "ConnectorCare Plan Type 2A", minFplPercent: 100, maxFplPercent: 150, monthlyPremiumPerPerson: 0, medicalOopSelfOnly: 750, medicalOopFamily: 1500, rxOopSelfOnly: 500, rxOopFamily: 1000 },
    { name: "ConnectorCare Plan Type 2B", minFplPercent: 150, maxFplPercent: 200, monthlyPremiumPerPerson: 53, medicalOopSelfOnly: 750, medicalOopFamily: 1500, rxOopSelfOnly: 500, rxOopFamily: 1000 },
    { name: "ConnectorCare Plan Type 3A", minFplPercent: 200, maxFplPercent: 250, monthlyPremiumPerPerson: 103, medicalOopSelfOnly: 1500, medicalOopFamily: 3000, rxOopSelfOnly: 750, rxOopFamily: 1500 },
    { name: "ConnectorCare Plan Type 3B", minFplPercent: 250, maxFplPercent: 300, monthlyPremiumPerPerson: 152, medicalOopSelfOnly: 1500, medicalOopFamily: 3000, rxOopSelfOnly: 750, rxOopFamily: 1500 },
    { name: "ConnectorCare Plan Type 3C", minFplPercent: 300, maxFplPercent: 400, monthlyPremiumPerPerson: 235, medicalOopSelfOnly: 1500, medicalOopFamily: 3000, rxOopSelfOnly: 750, rxOopFamily: 1500 }
  ]
});

export function massachusettsConnectorCareEstimate({
  income,
  householdSize = 1,
  marketplaceMembers = householdSize,
  planTypeName = "auto"
} = {}) {
  const annualIncome = Math.max(0, Number(income) || 0);
  const household = Math.max(1, Math.trunc(Number(householdSize) || 1));
  const members = Math.max(1, Math.trunc(Number(marketplaceMembers) || household));
  const fpl = connectorCareFplForHousehold(household);
  const fplPercent = fpl > 0 ? (annualIncome / fpl) * 100 : Infinity;
  const automaticPlanType = MASSACHUSETTS_CONNECTORCARE_2026.planTypes.find((row) => (
    fplPercent > row.minFplPercent && fplPercent <= row.maxFplPercent
  )) ?? (fplPercent <= 100 ? MASSACHUSETTS_CONNECTORCARE_2026.planTypes[0] : null);
  const requestedPlanType = connectorCarePlanTypeByName(planTypeName);
  const planType = automaticPlanType ? (requestedPlanType ?? automaticPlanType) : null;

  if (!planType) {
    return {
      eligible: false,
      source: MASSACHUSETTS_CONNECTORCARE_2026.source,
      fpl,
      fplPercent,
      reason: "ConnectorCare public plan types apply through 400% FPL."
    };
  }

  const familyCoverage = members > 1;
  const medicalOop = familyCoverage ? planType.medicalOopFamily : planType.medicalOopSelfOnly;
  const rxOop = familyCoverage ? planType.rxOopFamily : planType.rxOopSelfOnly;

  return {
    eligible: true,
    source: MASSACHUSETTS_CONNECTORCARE_2026.source,
    year: MASSACHUSETTS_CONNECTORCARE_2026.year,
    planName: planType.name,
    automaticPlanName: automaticPlanType?.name ?? null,
    userSelectedPlanType: !!requestedPlanType,
    fpl,
    fplPercent,
    monthlyPremiumPerPerson: planType.monthlyPremiumPerPerson,
    selectedPlanMonthlyPremium: planType.monthlyPremiumPerPerson * members,
    selectedPlanOopMaximum: medicalOop + rxOop,
    medicalOopMaximum: medicalOop,
    rxOopMaximum: rxOop,
    premiumInputMode: "net"
  };
}

export function massachusettsConnectorCarePlanOptions() {
  return MASSACHUSETTS_CONNECTORCARE_2026.planTypes.map((planType) => ({ ...planType }));
}

function connectorCarePlanTypeByName(planTypeName) {
  const name = String(planTypeName || "").trim();
  if (!name || name === "auto") return null;
  return MASSACHUSETTS_CONNECTORCARE_2026.planTypes.find((row) => row.name === name) ?? null;
}

function connectorCareFplForHousehold(householdSize) {
  const size = Math.max(1, Math.trunc(Number(householdSize) || 1));
  const { base, increment } = MASSACHUSETTS_CONNECTORCARE_2026.fplGuideline;
  return base + Math.max(0, size - 1) * increment;
}
