// Extracted from simulation.mjs during the modular refactor.
// Single responsibility: yearEngine. No behavior changes — pure code movement.

import { inflateAcaConfig } from "../aca.mjs";
import { accountBreakdown, ageHoldingPeriods, applyTotalReturnsWithIncome, harvestTaxGains, harvestTaxLosses, portfolioValue, removeEmptyLots } from "../portfolio.mjs";
import { computeIncomeTax, inflateTaxProfile } from "../tax.mjs?v=20260612-ladder-maintenance";
import { round } from "../utils.mjs";
import { allocationStrategyStateForYear } from "./allocation.mjs";
import { assetLocationStateForYear } from "./assetLocation.mjs";
import { earnedIncomeForYear, emptyEarnedIncome, mergeEarnedIncome, oneOffCashFlowsForYear } from "./cashFlows.mjs";
import { CASH_GAP_TOLERANCE, CASH_RAISED_EPSILON } from "./constants.mjs";
import { acaConfigForSimulationYear, buildSurvivorTaxProfile, isMarriedFiling, mortalityStatus } from "./household.mjs";
import { addHsaContributionLot, emptyHsaContribution, hsaContributionForYear, hsaQualifiedExpenseAvailableForWithdrawal, hsaStrategyConfig } from "./hsa.mjs";
import { acaMagiForIncome, federalAgiForIncome, incomeForYear, irmaaMagiForIncome, lossCarryforwardTotal, normalizeLossCarryforward, taxProfileForSimulationYear } from "./income.mjs?v=20260612-ladder-maintenance";
import { incomeStreamsForYear } from "./incomeStreams.mjs";
import { summarizeAssetClassReturns } from "./market.mjs";
import { computeAcaForYear, emptyMedicareCost, ltcStressCostForYear, medicalCostForYear } from "./medical.mjs";
import { addTaxableCash, assetOwner, assetSnapshot, traditionalAccountValueByOwner } from "./portfolioQueries.mjs";
import { householdRmdForYear } from "./rmd.mjs";
import { isLifetimeOptimizerEnabled } from "./scenario.mjs";
import { sequenceRiskReserveStateForYear } from "./sequenceRiskReserve.mjs";
import { socialSecurityBenefitsForYear, spouseSocialSecurityBenefitsForYear } from "./socialSecurity.mjs?v=20260612-ladder-maintenance";
import { plannedSpendingDetailForYear } from "./spending.mjs";
import { buildTipsLadder, maintainTipsLadder, matureTipsLadderRungs, repriceTipsLadderRungs, tipsLadderConfig, tipsLadderValue } from "./tipsLadder.mjs";
import { acaMagiCeiling, addPenaltyTax, automaticTaxLossHarvestLimit, effectiveRothConversionTargetRate, estimateTaxAttribution, gainHarvestingRoom, rothConversionAmountForYear, rothConversionMagiBuffer, strategyLimit } from "./taxStrategy.mjs?v=20260612-ladder-maintenance";
import { convertTraditionalToRoth, earlyWithdrawalPenaltyExceptionAmountForYear, emptyWithdrawal, mergeWithdrawals, rothBasisAvailableForWithdrawal, rothBasisSummaryForYear, withdrawForCash } from "./withdrawalExecution.mjs?v=20260612-ladder-maintenance";
import { forcedWithdrawalOrder } from "./withdrawalOrders.mjs";
import { chooseWithdrawalPlan, evaluateWithdrawalPlan } from "./withdrawalPlanning.mjs?v=20260612-ladder-maintenance";

export function simulateYear({
  portfolio,
  scenario,
  taxProfile,
  survivorTaxProfile = null,
  yearIndex,
  inflationIndex,
  medicalInflationIndex = null,
  returnByAssetClass,
  annualInflationRate,
  spendingGuardrail = null,
  lossCarryforward,
  rothBasisRemaining,
  hsaQualifiedExpenseBalance = 0,
  magiHistory = [],
  passedBaseSpend = null
}) {
  // Accept either a number (legacy: treated as long-term) or
  // { shortTerm, longTerm } object so callers can preserve §1212(b) character.
  lossCarryforward = normalizeLossCarryforward(lossCarryforward);
  const calendarYear = scenario.startYear + yearIndex;

  const { primaryAge: rawPrimaryAge, spouseAge: rawSpouseAge, primaryDeceased, spouseDeceased }
    = mortalityStatus(scenario, yearIndex);
  let age = rawPrimaryAge;
  let spouseAge = rawSpouseAge;

  const wasMarried = isMarriedFiling(taxProfile?.filingStatus);
  // Only enter the survivor branch when there's a real second life — an MFJ
  // profile with no spouseAge can't have a survivor; treating it as one would
  // null-propagate `age` through every downstream age-gated rule.
  const hasSpouseLife = spouseAge !== null;

  let baseProfileToUse = taxProfile;
  let customSocialSecurityBenefits = null;
  // Which life the household pools under once a survivor year nulls spouseAge;
  // the RMD clock needs to know when that survivor is the spouse.
  let survivorOwner = null;

  if (wasMarried && hasSpouseLife) {
    if (primaryDeceased && !spouseDeceased) {
      survivorOwner = "spouse";
      const originalAge = age;
      age = spouseAge;
      spouseAge = null;
      baseProfileToUse = survivorTaxProfile ?? buildSurvivorTaxProfile(taxProfile);
      const primarySS = socialSecurityBenefitsForYear(scenario, originalAge, inflationIndex, baseProfileToUse);
      const spouseSS = spouseSocialSecurityBenefitsForYear(scenario, age, inflationIndex, baseProfileToUse);
      // SSA survivor rule: surviving spouse keeps the higher of their own
      // benefit or the deceased's PIA. Reductions for survivors claiming
      // between age 60 and FRA (~71.5–99%) are NOT modeled.
      customSocialSecurityBenefits = Math.max(primarySS, spouseSS);
    } else if (!primaryDeceased && spouseDeceased) {
      const originalSpouseAge = spouseAge;
      spouseAge = null;
      baseProfileToUse = survivorTaxProfile ?? buildSurvivorTaxProfile(taxProfile);
      const primarySS = socialSecurityBenefitsForYear(scenario, age, inflationIndex, baseProfileToUse);
      const spouseSS = spouseSocialSecurityBenefitsForYear(scenario, originalSpouseAge, inflationIndex, baseProfileToUse);
      customSocialSecurityBenefits = Math.max(primarySS, spouseSS);
    }
  }

  const taxProfileContext = taxProfileForSimulationYear({
    inflatedProfile: inflateTaxProfile(baseProfileToUse, inflationIndex),
    baseProfile: baseProfileToUse,
    scenario,
    yearIndex,
    primaryAge: age,
    spouseAge
  });
  const yearTaxProfile = taxProfileContext.profile;
  const yearAcaBaseConfig = acaConfigForSimulationYear({
    config: scenario.aca,
    scenario,
    hasSpouseLife,
    primaryDeceased,
    spouseDeceased
  });
  const yearAcaConfig = inflateAcaConfig(yearAcaBaseConfig, inflationIndex, { age, yearIndex }, medicalInflationIndex);
  // Promote any prior-year-harvested "short" lots back to "long" once a
  // full simulation year has elapsed since the reset, before we compute
  // beginning-of-year snapshots and run any sales/harvests.
  ageHoldingPeriods(portfolio, calendarYear);
  const beginningPortfolioValue = portfolioValue(portfolio);
  const beginningTraditionalByOwner = traditionalAccountValueByOwner(portfolio);
  // Owner age clock for per-asset penalty/HSA-age rules. In survivor years
  // (spouseAge === null) the deceased's accounts are assumed rolled over to
  // the surviving holder, so both owners resolve to the surviving age.
  const ownerAges = { primary: age, spouse: Number.isFinite(spouseAge) ? spouseAge : age };
  const beginningAssets = assetSnapshot(portfolio);
  const dividends = applyTotalReturnsWithIncome(portfolio, returnByAssetClass);
  // Deterministic repricing for TIPS ladder rungs (skipped by the sampled
  // growth pass above): locked real yield compounding against the cumulative
  // inflation index, so each rung is worth face × inflationIndex at maturity.
  repriceTipsLadderRungs(portfolio, { scenario, yearIndex, inflationIndex });
  const afterReturnPortfolioValue = portfolioValue(portfolio);

  const flows = [...dividends.flows];
  const oneOffCashFlows = oneOffCashFlowsForYear(scenario, yearIndex + 1, inflationIndex);
  const recurringEarnedIncome = earnedIncomeForYear(scenario, inflationIndex, { primaryDeceased, spouseDeceased });
  const earnedIncome = mergeEarnedIncome(recurringEarnedIncome, oneOffCashFlows.earnedIncome);
  // Recurring income streams (pension/annuity/rent/other): owner-age gated,
  // optional COLA, survivor share, ordinary or tax-free character. The
  // ordinary portion joins household ordinary income; state-retirement-
  // eligible amounts also count as retirement ordinary income so state
  // pension/IRA exclusions apply.
  const streamIncome = incomeStreamsForYear({ scenario, yearIndex, inflationIndex });
  const incomeCashAvailable = round(recurringEarnedIncome.cash + oneOffCashFlows.income + streamIncome.cash, 6);
  let ordinaryIncome = dividends.ordinaryDividends + earnedIncome.ordinaryIncome + oneOffCashFlows.taxableOrdinaryIncome + streamIncome.ordinaryIncome;
  let qualifiedDividends = dividends.qualifiedDividends;
  const hsaContribution = hsaContributionForYear({
    scenario,
    age,
    spouseAge,
    inflationIndex
  });
  const adjustmentsToIncome = hsaContribution.amount;
  let strategyCapitalLosses = 0;
  let strategyShortTermLosses = 0;
  let strategyLongTermLosses = 0;
  let strategyShortTermGains = 0;
  let strategyLongTermGains = 0;
  const annualPenaltyExceptionAmount = earlyWithdrawalPenaltyExceptionAmountForYear(scenario);

  const lossHarvestLimit = strategyLimit({
    strategy: scenario.taxLossHarvesting,
    autoValue: automaticTaxLossHarvestLimit(portfolio, yearTaxProfile, lossCarryforwardTotal(lossCarryforward)),
    legacyField: "maxLoss",
    overrideField: "overrideMaxLoss"
  });
  const lossHarvest = scenario.taxLossHarvesting?.enabled
    ? harvestTaxLosses(portfolio, lossHarvestLimit, { calendarYear })
    : { realizedLosses: 0, shortTermLosses: 0, longTermLosses: 0, flows: [] };
  strategyCapitalLosses += lossHarvest.realizedLosses;
  strategyShortTermLosses += lossHarvest.shortTermLosses ?? 0;
  strategyLongTermLosses += lossHarvest.longTermLosses ?? 0;
  flows.push(...lossHarvest.flows);

  const assetLocation = assetLocationStateForYear({
    scenario,
    portfolio,
    calendarYear
  });
  strategyShortTermGains += assetLocation.shortTermCapitalGains;
  strategyLongTermGains += assetLocation.longTermCapitalGains;
  strategyCapitalLosses += assetLocation.capitalLosses;
  strategyShortTermLosses += assetLocation.shortTermCapitalLosses;
  strategyLongTermLosses += assetLocation.longTermCapitalLosses;
  flows.push(...assetLocation.flows);

  // One-time TIPS ladder carve-out at plan start (the "first rebalance"),
  // BEFORE the allocation rebalance so the remaining portfolio rebalances to
  // its stock target without the rungs. Taxable funding sales feed the same
  // strategy gain accounting as rebalance sales.
  let tipsLadderBuild = null;
  if (yearIndex === 0 && tipsLadderConfig(scenario).enabled) {
    const baseSpendingDetail = plannedSpendingDetailForYear(
      scenario,
      yearIndex + 1,
      inflationIndex,
      oneOffCashFlows,
      spendingGuardrail,
      passedBaseSpend
    );
    tipsLadderBuild = buildTipsLadder({
      portfolio,
      scenario,
      age,
      ownerAges,
      baseAnnualSpending: baseSpendingDetail.baseSpend,
      inflationIndex
    });
    if (tipsLadderBuild) {
      strategyShortTermGains += tipsLadderBuild.shortTermCapitalGains;
      strategyLongTermGains += tipsLadderBuild.longTermCapitalGains;
      strategyCapitalLosses += tipsLadderBuild.capitalLosses;
      strategyShortTermLosses += tipsLadderBuild.shortTermCapitalLosses;
      strategyLongTermLosses += tipsLadderBuild.longTermCapitalLosses;
      flows.push(...tipsLadderBuild.flows);
    }
  }

  // Yearly TIPS ladder maintenance (replenish / roll per maintenanceMode),
  // BEFORE the allocation rebalance so the managed sleeve rebalances around
  // the post-maintenance ladder. Taxable purchase/roll sales feed the same
  // strategy gain accounting as rebalance sales.
  let tipsLadderMaintenance = null;
  if (yearIndex > 0 && tipsLadderConfig(scenario).enabled && tipsLadderConfig(scenario).maintenanceMode !== "none") {
    const maintenanceSpendingDetail = plannedSpendingDetailForYear(
      scenario,
      yearIndex + 1,
      inflationIndex,
      oneOffCashFlows,
      spendingGuardrail,
      passedBaseSpend
    );
    tipsLadderMaintenance = maintainTipsLadder({
      portfolio,
      scenario,
      age,
      ownerAges,
      yearIndex,
      inflationIndex,
      stockReturn: returnByAssetClass?.stock ?? 0,
      // baseSpend is nominal (already inflated); rung faces are REAL dollars.
      baseAnnualSpending: maintenanceSpendingDetail.baseSpend / Math.max(inflationIndex, 0.000001)
    });
    if (tipsLadderMaintenance) {
      strategyShortTermGains += tipsLadderMaintenance.shortTermCapitalGains;
      strategyLongTermGains += tipsLadderMaintenance.longTermCapitalGains;
      strategyCapitalLosses += tipsLadderMaintenance.capitalLosses;
      strategyShortTermLosses += tipsLadderMaintenance.shortTermCapitalLosses;
      strategyLongTermLosses += tipsLadderMaintenance.longTermCapitalLosses;
      flows.push(...tipsLadderMaintenance.flows);
    }
  }

  const allocationStrategy = allocationStrategyStateForYear({
    scenario,
    portfolio,
    yearIndex,
    calendarYear
  });
  strategyShortTermGains += allocationStrategy.shortTermCapitalGains;
  strategyLongTermGains += allocationStrategy.longTermCapitalGains;
  strategyCapitalLosses += allocationStrategy.capitalLosses;
  strategyShortTermLosses += allocationStrategy.shortTermCapitalLosses;
  strategyLongTermLosses += allocationStrategy.longTermCapitalLosses;
  flows.push(...allocationStrategy.flows);

  // Per-owner RMDs: spouse-owned traditional accounts use the spouse's age,
  // factor, and SECURE 2.0 start age; each bucket withdraws only from that
  // owner's traditional lots. Untagged portfolios resolve to a single primary
  // bucket — the exact pre-owner-dimension behavior.
  const rmd = householdRmdForYear({
    scenario,
    primaryAge: age,
    spouseAge,
    traditionalByOwner: beginningTraditionalByOwner,
    survivorOwner
  });
  let rmdWithdrawal = emptyWithdrawal(rothBasisRemaining, annualPenaltyExceptionAmount);
  // TIPS ladder rungs maturing this year are distributed BEFORE the forced
  // RMD sales, through the same withdrawal machinery (ordinary income, MAGI,
  // penalties, Roth basis all flow normally). Traditional maturities then
  // credit against that owner's RMD so the ladder does not stack a second
  // forced distribution on top.
  const tipsLadderMaturity = matureTipsLadderRungs({
    portfolio,
    yearIndex,
    context: {
      age,
      ownerAges,
      calendarYear,
      penaltyAge: scenario.retirementPenaltyAge ?? 59.5,
      penaltyRate: scenario.earlyWithdrawalPenaltyRate ?? 0.1,
      rothBasisRemaining: rmdWithdrawal.rothBasisRemaining,
      rothFiveYearRuleSatisfied: scenario.rothFiveYearRuleSatisfied !== false,
      penaltyExceptionRemaining: rmdWithdrawal.penaltyExceptionRemaining,
      returnAssumptions: scenario.returnAssumptions
    }
  });
  if (tipsLadderMaturity) {
    rmdWithdrawal = mergeWithdrawals(rmdWithdrawal, tipsLadderMaturity.withdrawal);
  }
  const ladderRmdCredit = tipsLadderMaturity?.traditionalByOwner ?? { primary: 0, spouse: 0 };
  const rmdBuckets = rmd.byOwner.spouse
    ? [
      {
        amount: Math.max(0, (rmd.byOwner.primary?.amount ?? 0) - ladderRmdCredit.primary),
        assets: portfolio.filter((asset) => asset.accountType === "traditional" && assetOwner(asset) !== "spouse")
      },
      {
        amount: Math.max(0, (rmd.byOwner.spouse?.amount ?? 0) - ladderRmdCredit.spouse),
        assets: portfolio.filter((asset) => asset.accountType === "traditional" && assetOwner(asset) === "spouse")
      }
    ]
    : [{ amount: Math.max(0, rmd.amount - ladderRmdCredit.primary - ladderRmdCredit.spouse), assets: portfolio }];
  for (const bucket of rmdBuckets) {
    if (!(bucket.amount > 0)) continue;
    const bucketContext = {
      age,
      ownerAges,
      calendarYear,
      penaltyAge: scenario.retirementPenaltyAge ?? 59.5,
      penaltyRate: scenario.earlyWithdrawalPenaltyRate ?? 0.1,
      rothBasisRemaining: rmdWithdrawal.rothBasisRemaining,
      rothFiveYearRuleSatisfied: scenario.rothFiveYearRuleSatisfied !== false,
      penaltyExceptionRemaining: rmdWithdrawal.penaltyExceptionRemaining,
      returnAssumptions: scenario.returnAssumptions,
      optimizedLotSelection: isLifetimeOptimizerEnabled(scenario)
    };
    let bucketWithdrawal = withdrawForCash(bucket.assets, bucket.amount, ["traditional"], bucketContext);
    // An RMD is a LEGAL minimum: when the owner's non-rung traditional sleeve
    // cannot satisfy it, the remainder must come out of TIPS ladder rungs
    // (sold/distributed at their accreted value — rungs sort last). Without
    // this pass, a rung-dominated IRA under "spend-on-stress" maintenance
    // would silently distribute $0 while an RMD is owed, understating
    // ordinary income, taxes, and IRMAA/ACA MAGI.
    const unmetRmd = bucket.amount - bucketWithdrawal.cashRaised;
    if (unmetRmd > CASH_RAISED_EPSILON) {
      const rungFallback = withdrawForCash(bucket.assets, unmetRmd, ["traditional"], {
        ...bucketContext,
        rothBasisRemaining: bucketWithdrawal.rothBasisRemaining,
        penaltyExceptionRemaining: bucketWithdrawal.penaltyExceptionRemaining,
        includeTipsLadderRungs: true
      });
      bucketWithdrawal = mergeWithdrawals(bucketWithdrawal, rungFallback);
    }
    rmdWithdrawal = mergeWithdrawals(rmdWithdrawal, bucketWithdrawal);
  }
  rothBasisRemaining = rmdWithdrawal.rothBasisRemaining;

  let socialSecurityBenefits = 0;
  if (customSocialSecurityBenefits !== null) {
    socialSecurityBenefits = customSocialSecurityBenefits;
  } else {
    const primarySS = socialSecurityBenefitsForYear(scenario, age, inflationIndex, yearTaxProfile);
    const spouseSS = spouseSocialSecurityBenefitsForYear(scenario, spouseAge, inflationIndex, yearTaxProfile);
    socialSecurityBenefits = primarySS + spouseSS;
  }

  const rothConversionAmount = scenario.rothConversion?.enabled
    ? convertTraditionalToRoth(portfolio, rothConversionAmountForYear({
      portfolio,
      scenario,
      taxProfile: yearTaxProfile,
      acaConfig: yearAcaConfig,
      ordinaryIncome,
      earnedIncome,
      ordinaryInvestmentIncome: dividends.ordinaryDividends,
      qualifiedDividends,
      adjustmentsToIncome,
      socialSecurityBenefits,
      age,
      spouseAge,
      inflationIndex,
      medicalInflationIndex: medicalInflationIndex ?? inflationIndex,
      yearIndex,
      magiHistory,
      lossCarryforward
    }), calendarYear)
    : 0;
  ordinaryIncome += rothConversionAmount;
  // Retirement-character ordinary income for state exclusions: conversions
  // plus state-retirement-eligible income streams (withdrawal ordinary income
  // is added downstream by incomeForYear).
  const retirementOrdinaryIncomeBase = round(rothConversionAmount + streamIncome.retirementOrdinaryIncome, 6);
  if (rothConversionAmount > 0) {
    flows.push({
      from: "Traditional accounts",
      to: "Roth conversion",
      amount: rothConversionAmount,
      type: "conversion"
    });
    flows.push({
      from: "Roth conversion",
      to: "Roth accounts",
      amount: rothConversionAmount,
      type: "conversion"
    });
  }

  const plannedSpendingDetail = plannedSpendingDetailForYear(
    scenario,
    yearIndex + 1,
    inflationIndex,
    oneOffCashFlows,
    spendingGuardrail,
    passedBaseSpend
  );
  const plannedSpending = plannedSpendingDetail.total;
  const sequenceRiskReserve = sequenceRiskReserveStateForYear({
    scenario,
    portfolio,
    plannedSpending,
    returnByAssetClass,
    yearIndex
  });
  let finalWithdrawal = null;
  let finalTaxes = null;
  let finalAca = null;
  let finalMedicare = emptyMedicareCost();
  let finalTaxableSocialSecurity = 0;
  let finalPortfolio = null;
  let finalRothBasisOptimization = null;
  let medicalEstimate = 0;
  let taxEstimate = 0;

  // Around ACA / IRMAA cliffs the withdrawal can oscillate between two states.
  // Track the prior estimate and exit early on convergence; if the loop fails
  // to converge, fall back to the highest-cost iteration so we don't ship a
  // silently understated tax/medical estimate.
  const MAX_FIXED_POINT_ITERATIONS = 10;
  const FIXED_POINT_TOLERANCE = 1;
  let prevTax = null;
  let prevMedical = null;
  let converged = false;
  let highestCostPlan = null;
  let highestCostTotal = -Infinity;

  for (let iteration = 0; iteration < MAX_FIXED_POINT_ITERATIONS; iteration += 1) {
    const cashRequired = plannedSpending
      + (scenario.targetSpendIncludesMedical ? 0 : medicalEstimate)
      + (scenario.targetSpendIncludesTaxes ? 0 : taxEstimate)
      + hsaContribution.amount;
    const chosenPlan = chooseWithdrawalPlan({
      portfolio,
      amount: Math.max(0, cashRequired - dividends.cash - incomeCashAvailable - rmdWithdrawal.cashRaised - socialSecurityBenefits),
      baseWithdrawal: rmdWithdrawal,
      withdrawalOrder: scenario.withdrawalOrder,
      withdrawalContext: {
        age,
        ownerAges,
        calendarYear,
        penaltyAge: scenario.retirementPenaltyAge ?? 59.5,
        penaltyRate: scenario.earlyWithdrawalPenaltyRate ?? 0.1,
        rothBasisRemaining: rmdWithdrawal.rothBasisRemaining,
        rothBasisAvailable: rothBasisAvailableForWithdrawal(portfolio, {
          rothBasisRemaining: rmdWithdrawal.rothBasisRemaining,
          age,
          calendarYear,
          penaltyAge: scenario.retirementPenaltyAge ?? 59.5
        }),
        rothFiveYearRuleSatisfied: scenario.rothFiveYearRuleSatisfied !== false,
        penaltyExceptionRemaining: rmdWithdrawal.penaltyExceptionRemaining,
        returnAssumptions: scenario.returnAssumptions,
        optimizedLotSelection: isLifetimeOptimizerEnabled(scenario) || sequenceRiskReserve.enabled,
        sequenceRiskReserve,
        allocationStrategy,
        hsaQualifiedExpenseAvailable: hsaQualifiedExpenseAvailableForWithdrawal({
          scenario,
          hsaQualifiedExpenseBalance,
          medicalEstimate
        })
      },
      evaluationContext: {
        scenario,
        yearTaxProfile,
        yearAcaConfig,
        inflationIndex,
        medicalInflationIndex: medicalInflationIndex ?? inflationIndex,
        ordinaryIncome,
        earnedIncome,
        retirementOrdinaryIncome: retirementOrdinaryIncomeBase,
        ordinaryInvestmentIncome: dividends.ordinaryDividends,
        qualifiedDividends,
        adjustmentsToIncome,
        strategyShortTermGains,
        strategyLongTermGains,
        strategyCapitalLosses,
        strategyShortTermLosses,
        strategyLongTermLosses,
        lossCarryforward,
        socialSecurityBenefits,
        age,
        spouseAge,
        yearIndex,
        magiHistory
      }
    });

    const nextMedical = scenario.targetSpendIncludesMedical ? 0 : chosenPlan.medicalTotal;
    const nextTax = chosenPlan.taxes.totalTax;
    const totalCost = nextMedical + nextTax;
    if (totalCost > highestCostTotal) {
      highestCostTotal = totalCost;
      highestCostPlan = chosenPlan;
    }

    medicalEstimate = nextMedical;
    taxEstimate = nextTax;

    finalWithdrawal = chosenPlan.withdrawal;
    finalTaxes = chosenPlan.taxes;
    finalAca = chosenPlan.aca;
    finalMedicare = chosenPlan.medicare;
    finalTaxableSocialSecurity = chosenPlan.taxableSocialSecurity;
    finalPortfolio = chosenPlan.portfolio;
    finalRothBasisOptimization = chosenPlan.rothBasisOptimization;

    if (prevTax !== null
      && Math.abs(nextTax - prevTax) + Math.abs(nextMedical - prevMedical) < FIXED_POINT_TOLERANCE) {
      converged = true;
      break;
    }
    prevTax = nextTax;
    prevMedical = nextMedical;
  }

  if (!converged && highestCostPlan) {
    finalWithdrawal = highestCostPlan.withdrawal;
    finalTaxes = highestCostPlan.taxes;
    finalAca = highestCostPlan.aca;
    finalMedicare = highestCostPlan.medicare;
    finalTaxableSocialSecurity = highestCostPlan.taxableSocialSecurity;
    finalPortfolio = highestCostPlan.portfolio;
    finalRothBasisOptimization = highestCostPlan.rothBasisOptimization;
    medicalEstimate = scenario.targetSpendIncludesMedical ? 0 : highestCostPlan.medicalTotal;
    taxEstimate = highestCostPlan.taxes.totalTax;
  }

  if (scenario.taxGainHarvesting?.enabled) {
    const gainHarvestLimit = gainHarvestingRoom({
      taxes: finalTaxes,
      taxProfile: yearTaxProfile,
      acaConfig: yearAcaConfig,
      currentMagi: acaMagiForIncome(incomeForYear({
        ordinaryIncome,
        earnedIncome,
        retirementOrdinaryIncome: retirementOrdinaryIncomeBase,
        ordinaryInvestmentIncome: dividends.ordinaryDividends,
        qualifiedDividends,
        strategyShortTermGains,
        strategyLongTermGains,
        strategyCapitalLosses,
        strategyShortTermLosses,
        strategyLongTermLosses,
        withdrawal: finalWithdrawal,
        socialSecurityBenefits,
        taxProfile: yearTaxProfile,
        scenario,
        adjustmentsToIncome,
        lossCarryforward
      }).income, lossCarryforward, yearTaxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000, yearTaxProfile),
      configuredMaxGain: strategyLimit({
        strategy: scenario.taxGainHarvesting,
        autoValue: Infinity,
        legacyField: "maxGain",
        overrideField: "overrideMaxGain"
      }),
      portfolio: finalPortfolio,
      scenario,
      inflationIndex,
      medicalInflationIndex: medicalInflationIndex ?? inflationIndex,
      ordinaryIncome,
      earnedIncome,
      retirementOrdinaryIncome: retirementOrdinaryIncomeBase,
      ordinaryInvestmentIncome: dividends.ordinaryDividends,
      qualifiedDividends,
      adjustmentsToIncome,
      strategyShortTermGains,
      strategyLongTermGains,
      strategyCapitalLosses,
      strategyShortTermLosses,
      strategyLongTermLosses,
      withdrawal: finalWithdrawal,
      socialSecurityBenefits,
      lossCarryforward,
      age,
      spouseAge,
      yearIndex,
      magiHistory
    });
    const gainHarvest = harvestTaxGains(finalPortfolio, gainHarvestLimit, { calendarYear });
    strategyLongTermGains += gainHarvest.realizedGains;
    flows.push(...gainHarvest.flows);

    if (gainHarvest.realizedGains > 0) {
      const { income, taxableSocialSecurity } = incomeForYear({
        ordinaryIncome,
        earnedIncome,
        retirementOrdinaryIncome: retirementOrdinaryIncomeBase,
        ordinaryInvestmentIncome: dividends.ordinaryDividends,
        qualifiedDividends,
        adjustmentsToIncome,
        strategyShortTermGains,
        strategyLongTermGains,
        strategyCapitalLosses,
        strategyShortTermLosses,
        strategyLongTermLosses,
        withdrawal: finalWithdrawal,
        socialSecurityBenefits,
        taxProfile: yearTaxProfile,
        scenario,
        lossCarryforward
      });
      finalTaxes = computeIncomeTax({
        ...income,
        capitalLossCarryforward: lossCarryforward,
        profile: yearTaxProfile
      });
      finalTaxes = addPenaltyTax(finalTaxes, finalWithdrawal.penaltyTax);
      const acaMagi = acaMagiForIncome(income, lossCarryforward, yearTaxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000, yearTaxProfile);
      const irmaaMagi = irmaaMagiForIncome(income, lossCarryforward, yearTaxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000, yearTaxProfile);
      finalAca = computeAcaForYear({ age, spouseAge, magi: acaMagi, config: yearAcaConfig, filingStatus: yearTaxProfile.filingStatus });
      if (!scenario.targetSpendIncludesMedical) {
        const medical = medicalCostForYear({
          scenario,
          aca: finalAca,
          yearAcaConfig,
          inflationIndex,
          medicalInflationIndex: medicalInflationIndex ?? inflationIndex,
          age,
          spouseAge,
          yearIndex,
          filingStatus: yearTaxProfile.filingStatus,
          irmaaMagi,
          magiHistory
        });
        medicalEstimate = medical.total;
        finalMedicare = medical.medicare;
      }
      finalTaxableSocialSecurity = taxableSocialSecurity;
    }
  }

  const reconciled = reconcileCashRequirement({
    portfolio: finalPortfolio,
    withdrawal: finalWithdrawal,
    taxes: finalTaxes,
    aca: finalAca,
    medicare: finalMedicare,
    taxableSocialSecurity: finalTaxableSocialSecurity,
    medicalEstimate,
    scenario,
    yearTaxProfile,
    yearAcaConfig,
    inflationIndex,
    medicalInflationIndex,
    plannedSpending,
    hsaContributionAmount: hsaContribution.amount,
    dividends,
    incomeCashAvailable,
    ordinaryIncome,
    earnedIncome,
    retirementOrdinaryIncome: retirementOrdinaryIncomeBase,
    ordinaryInvestmentIncome: dividends.ordinaryDividends,
    qualifiedDividends,
    adjustmentsToIncome,
    strategyShortTermGains,
    strategyLongTermGains,
    strategyCapitalLosses,
    strategyShortTermLosses,
    strategyLongTermLosses,
    lossCarryforward,
    socialSecurityBenefits,
    hsaQualifiedExpenseBalance,
    age,
    ownerAges,
    spouseAge,
    yearIndex,
    calendarYear,
    magiHistory,
    sequenceRiskReserve,
    allocationStrategy
  });
  finalWithdrawal = reconciled.withdrawal;
  finalTaxes = reconciled.taxes;
  finalAca = reconciled.aca;
  finalMedicare = reconciled.medicare;
  finalTaxableSocialSecurity = reconciled.taxableSocialSecurity;
  finalRothBasisOptimization = reconciled.rothBasisOptimization ?? finalRothBasisOptimization;
  medicalEstimate = reconciled.medicalEstimate;

  const totalCashRequired = plannedSpending
    + (scenario.targetSpendIncludesMedical ? 0 : medicalEstimate)
    + (scenario.targetSpendIncludesTaxes ? 0 : finalTaxes.totalTax)
    + hsaContribution.amount;
  const { income: finalIncome, taxableSocialSecurity: reconciledTaxableSocialSecurity } = incomeForYear({
    ordinaryIncome,
    earnedIncome,
    retirementOrdinaryIncome: retirementOrdinaryIncomeBase,
    ordinaryInvestmentIncome: dividends.ordinaryDividends,
    qualifiedDividends,
    adjustmentsToIncome,
    strategyShortTermGains,
    strategyLongTermGains,
    strategyCapitalLosses,
    strategyShortTermLosses,
    strategyLongTermLosses,
    withdrawal: finalWithdrawal,
    socialSecurityBenefits,
    taxProfile: yearTaxProfile,
    scenario,
    lossCarryforward
  });
  finalTaxableSocialSecurity = reconciledTaxableSocialSecurity;
  const finalFederalAgi = round(federalAgiForIncome(finalIncome, lossCarryforward, yearTaxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000, yearTaxProfile), 6);
  const finalAcaMagi = round(acaMagiForIncome(finalIncome, lossCarryforward, yearTaxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000, yearTaxProfile), 6);
  const finalIrmaaMagi = round(irmaaMagiForIncome(finalIncome, lossCarryforward, yearTaxProfile?.capitalLossOrdinaryIncomeOffset ?? 3000, yearTaxProfile), 6);
  const finalMagi = finalAcaMagi;
  // Use the same net-benefit gate as the conversion sizing so the displayed
  // ceiling reflects the actual cap the optimizer applied.
  const finalAcaMagiTarget = acaMagiCeiling({
    acaConfig: yearAcaConfig,
    currentMagi: finalMagi,
    maxFplPercent: scenario.rothConversion?.maxAcaFplPercent ?? 400,
    targetRate: scenario.rothConversion?.enabled
      ? effectiveRothConversionTargetRate({
          portfolio,
          scenario,
          age,
          taxProfile: yearTaxProfile,
          ordinaryIncome: finalIncome.ordinaryIncome
        })
      : null,
    magiBuffer: rothConversionMagiBuffer(scenario)
  });
  const taxAttribution = estimateTaxAttribution({
    taxProfile: yearTaxProfile,
    lossCarryforward,
    income: finalIncome,
    finalTaxes,
    earnedIncome: recurringEarnedIncome,
    oneOffCashFlows,
    dividends,
    rothConversionAmount,
    withdrawal: finalWithdrawal,
    hsaContribution,
    strategyShortTermGains,
    strategyLongTermGains,
    allocationStrategy,
    assetLocation,
    taxableSocialSecurity: finalTaxableSocialSecurity
  });
  flows.push(...finalWithdrawal.flows);
  if (socialSecurityBenefits > 0) {
    flows.push({
      from: "Social Security",
      to: "Spending reserve",
      amount: socialSecurityBenefits,
      type: "income"
    });
  }
  if (recurringEarnedIncome.cash > 0) {
    flows.push({
      from: "Earned income",
      to: "Spending reserve",
      amount: recurringEarnedIncome.cash,
      type: "income"
    });
  }
  if (oneOffCashFlows.income > 0) {
    flows.push({
      from: "One-off income",
      to: "Spending reserve",
      amount: oneOffCashFlows.income,
      type: "income"
    });
  }
  if (streamIncome.cash > 0) {
    flows.push({
      from: "Pension / annuity / recurring income",
      to: "Spending reserve",
      amount: streamIncome.cash,
      type: "income"
    });
  }
  const taxRefundCash = scenario.targetSpendIncludesTaxes ? 0 : Math.max(0, -finalTaxes.totalTax);
  if (taxRefundCash > 0) {
    flows.push({
      from: "Tax refund",
      to: "Spending reserve",
      amount: taxRefundCash,
      type: "income"
    });
  }
  if (finalTaxes.totalTax > 0) {
    const incomeTax = Math.max(0, finalTaxes.totalTax - (finalTaxes.penaltyTax ?? 0));
    if (incomeTax > 0) flows.push({ from: "Spending reserve", to: "Tax payment", amount: incomeTax, type: "tax" });
    if ((finalTaxes.penaltyTax ?? 0) > 0) {
      flows.push({
        from: "Spending reserve",
        to: "Early withdrawal penalties",
        amount: finalTaxes.penaltyTax,
        type: "penalty"
      });
    }
  }
  if (medicalEstimate > 0) {
    flows.push({ from: "Spending reserve", to: "Medical", amount: medicalEstimate, type: "medical" });
  }
  if (hsaContribution.amount > 0) {
    addHsaContributionLot(finalPortfolio, hsaContribution, {
      calendarYear,
      returnAssumptions: scenario.returnAssumptions
    });
    flows.push({
      from: "Spending reserve",
      to: "HSA contribution",
      amount: hsaContribution.amount,
      type: "contribution"
    });
  }
  if (plannedSpendingDetail.strategy?.mode === "discretionaryGuardrails") {
    if (plannedSpendingDetail.essentialSpend > 0) {
      flows.push({
        from: "Spending reserve",
        to: "Essential spending",
        amount: plannedSpendingDetail.essentialSpend,
        type: "spending"
      });
    }
    if (plannedSpendingDetail.discretionarySpend > 0) {
      flows.push({
        from: "Spending reserve",
        to: "Discretionary spending",
        amount: plannedSpendingDetail.discretionarySpend,
        type: "spending"
      });
    }
    if (plannedSpendingDetail.oneOffExpenses > 0) {
      flows.push({
        from: "Spending reserve",
        to: "One-off spending",
        amount: plannedSpendingDetail.oneOffExpenses,
        type: "spending"
      });
    }
  } else if (plannedSpending > 0) {
    flows.push({ from: "Spending reserve", to: "Lifestyle and one-off spending", amount: plannedSpending, type: "spending" });
  }

  const cashAvailable = dividends.cash + incomeCashAvailable + socialSecurityBenefits + finalWithdrawal.cashRaised;
  const unspentCash = Math.max(0, cashAvailable - totalCashRequired);
  if (unspentCash > 1) {
    addTaxableCash(finalPortfolio, unspentCash, calendarYear);
    flows.push({ from: "Spending reserve", to: "Taxable cash reserve", amount: unspentCash, type: "balance" });
  }

  portfolio.splice(0, portfolio.length, ...finalPortfolio);
  removeEmptyLots(portfolio);
  const endingAssets = assetSnapshot(portfolio);
  const rothBasisSummary = rothBasisSummaryForYear(finalPortfolio, {
    age,
    calendarYear,
    penaltyAge: scenario.retirementPenaltyAge ?? 59.5
  });

  const cashShortfall = Math.max(0, totalCashRequired - cashAvailable);
  const unfunded = cashShortfall <= CASH_GAP_TOLERANCE ? 0 : cashShortfall;
  // Only the qualified portion of HSA proceeds draws down the tracked pool —
  // at 65+ the engine may sell beyond it (taxed as ordinary income), and that
  // excess must not double-debit the qualified-expense balance.
  const finalHsaQualifiedExpenseBalance = hsaStrategyConfig(scenario).useForQualifiedExpenses
    ? round(Math.max(0, hsaQualifiedExpenseBalance + medicalEstimate - (finalWithdrawal.hsaQualifiedExpenseUsed ?? finalWithdrawal.hsaProceeds ?? 0)), 6)
    : hsaQualifiedExpenseBalance;

  return {
    year: calendarYear,
    yearIndex: yearIndex + 1,
    age: round(age, 2),
    inflationIndex: round(inflationIndex, 6),
    beginningPortfolioValue,
    beginningAssets,
    assetClassReturns: summarizeAssetClassReturns(returnByAssetClass, annualInflationRate),
    afterReturnPortfolioValue,
    endingPortfolioValue: portfolioValue(portfolio),
    plannedSpending: round(plannedSpending, 6),
    spendingStrategy: plannedSpendingDetail.strategy,
    essentialSpending: round(plannedSpendingDetail.essentialSpend, 6),
    discretionarySpending: round(plannedSpendingDetail.discretionarySpend, 6),
    discretionarySpendingBudget: round(plannedSpendingDetail.discretionaryBudget, 6),
    spendingGuardrail: plannedSpendingDetail.guardrail,
    medicalCost: round(medicalEstimate, 6),
    medicare: finalMedicare,
    // LTC stress reaches cash flow only through medicalCostForYear, which
    // every spending path skips under targetSpendIncludesMedical — report 0
    // there rather than a charge that was never applied (the combination is
    // documented in KNOWN_LIMITATIONS).
    ltcCost: scenario.targetSpendIncludesMedical
      ? 0
      : round(ltcStressCostForYear({ scenario, yearIndex, medicalInflationIndex: medicalInflationIndex ?? inflationIndex }), 6),
    spendingPhase: plannedSpendingDetail.spendingPhase ?? null,
    age65AdditionalDeduction: round(taxProfileContext.age65AdditionalDeduction, 6),
    enhancedSeniorDeduction: round(finalTaxes.enhancedSeniorDeduction ?? 0, 6),
    enhancedSeniorDeductionEligibleCount: taxProfileContext.enhancedSeniorDeductionEligibleCount ?? 0,
    enhancedSeniorDeductionTaxYear: taxProfileContext.enhancedSeniorDeductionTaxYear ?? calendarYear,
    qualifyingChildren: yearTaxProfile.qualifyingChildren,
    earnedIncome: round(recurringEarnedIncome.cash, 6),
    streamIncome: {
      cash: round(streamIncome.cash, 6),
      ordinaryIncome: round(streamIncome.ordinaryIncome, 6),
      retirementOrdinaryIncome: round(streamIncome.retirementOrdinaryIncome, 6),
      taxFreeIncome: round(streamIncome.taxFreeIncome, 6),
      details: streamIncome.details
    },
    oneOffIncome: round(oneOffCashFlows.income, 6),
    taxRefundCash: round(taxRefundCash, 6),
    oneOffExpenses: round(oneOffCashFlows.expenses, 6),
    oneOffIncomeDetails: oneOffCashFlows.incomeDetails,
    oneOffExpenseDetails: oneOffCashFlows.expenseDetails,
    medicareWages: round(earnedIncome.medicareWages, 6),
    socialSecurityWages: earnedIncome.socialSecurityWages == null ? null : round(earnedIncome.socialSecurityWages, 6),
    selfEmploymentIncome: round(earnedIncome.selfEmploymentIncome, 6),
    rrtaCompensation: round(earnedIncome.rrtaCompensation, 6),
    socialSecurityBenefits: round(socialSecurityBenefits, 6),
    taxableSocialSecurity: round(finalTaxableSocialSecurity, 6),
    // Forced RMD sales only — TIPS ladder maturities (which credit against
    // the RMD) are reported separately under tipsLadder.maturedCash.
    rmdAmount: round(Math.max(0, rmdWithdrawal.cashRaised - (tipsLadderMaturity?.maturedCash ?? 0)), 6),
    rmdRequired: round(rmd.amount, 6),
    rmdStartAge: rmd.startAge,
    rmdFactor: rmd.factor,
    rmdBase: round(rmd.base, 6),
    rmdByOwner: rmd.byOwner.spouse ? {
      primary: {
        amount: round(rmd.byOwner.primary?.amount ?? 0, 6),
        factor: rmd.byOwner.primary?.factor ?? null,
        startAge: rmd.byOwner.primary?.startAge ?? null
      },
      spouse: {
        amount: round(rmd.byOwner.spouse.amount, 6),
        factor: rmd.byOwner.spouse.factor,
        startAge: rmd.byOwner.spouse.startAge
      }
    } : null,
    cashRaised: round(finalWithdrawal.cashRaised, 6),
    taxableDividendsCash: dividends.cash,
    taxableDividendDetails: dividends.details,
    cashAvailable: round(cashAvailable, 6),
    unspentCash: round(unspentCash, 6),
    totalCashRequired: round(totalCashRequired, 6),
    taxes: finalTaxes,
    taxAttribution,
    aca: finalAca,
    acaMagiCeiling: Number.isFinite(finalAcaMagiTarget.amount) ? finalAcaMagiTarget.amount : null,
    acaMagiCeilingFplPercent: Number.isFinite(finalAcaMagiTarget.fplPercent) ? finalAcaMagiTarget.fplPercent : null,
    federalAgi: finalFederalAgi,
    acaMagi: finalAcaMagi,
    irmaaMagi: finalIrmaaMagi,
    magi: finalMagi,
    realizedLongTermGains: round(strategyLongTermGains + finalWithdrawal.longTermCapitalGains, 6),
    taxGainHarvested: round(Math.max(
      0,
      strategyLongTermGains
        - allocationStrategy.longTermCapitalGains
        - assetLocation.longTermCapitalGains
    ), 6),
    realizedShortTermGains: round(strategyShortTermGains + finalWithdrawal.shortTermCapitalGains, 6),
    realizedCapitalLosses: round(strategyCapitalLosses + finalWithdrawal.capitalLosses, 6),
    lossCarryforward: finalTaxes.lossCarryforward,
    lossCarryforwardDetail: {
      shortTerm: finalTaxes.lossCarryforwardShort ?? 0,
      longTerm: finalTaxes.lossCarryforwardLong ?? finalTaxes.lossCarryforward ?? 0
    },
    rothConversionAmount: round(rothConversionAmount, 6),
    penaltyTax: round(finalTaxes.penaltyTax ?? 0, 6),
    penaltyBase: round(finalWithdrawal.penaltyBase ?? 0, 6),
    penaltyExceptionUsed: round(finalWithdrawal.penaltyExceptionUsed ?? 0, 6),
    penaltyExceptionRemaining: round(finalWithdrawal.penaltyExceptionRemaining ?? 0, 6),
    rothWithdrawals: round(finalWithdrawal.rothProceeds, 6),
    rothBasisUsed: round(finalWithdrawal.rothBasisUsed, 6),
    rothBasisRemaining: round(finalWithdrawal.rothBasisRemaining, 6),
    rothContributionBasisRemaining: round(finalWithdrawal.rothBasisRemaining, 6),
    rothConversionPrincipalRemaining: rothBasisSummary.conversionPrincipal,
    rothPenaltyFreeConversionPrincipal: rothBasisSummary.penaltyFreeConversionPrincipal,
    rothBasisAvailable: round(finalWithdrawal.rothBasisRemaining + rothBasisSummary.penaltyFreeConversionPrincipal, 6),
    rothFiveYearRuleSatisfied: scenario.rothFiveYearRuleSatisfied !== false,
    rothBasisOptimization: finalRothBasisOptimization,
    hsaContribution,
    hsaWithdrawals: round(finalWithdrawal.hsaProceeds ?? 0, 6),
    hsaQualifiedExpenseBalance: finalHsaQualifiedExpenseBalance,
    sequenceRiskReserve,
    tipsLadder: tipsLadderConfig(scenario).enabled ? {
      value: tipsLadderValue(portfolio),
      maturedCash: round(tipsLadderMaturity?.maturedCash ?? 0, 6),
      build: tipsLadderBuild ? {
        requestedYears: tipsLadderBuild.requestedYears,
        fundedYears: tipsLadderBuild.fundedYears,
        annualRealAmount: round(tipsLadderBuild.annualRealAmount ?? 0, 6),
        realYield: tipsLadderBuild.realYield,
        totalCost: round(tipsLadderBuild.totalCost, 6),
        shortfall: round(tipsLadderBuild.shortfall, 6)
      } : null,
      maintenance: tipsLadderMaintenance ? {
        mode: tipsLadderMaintenance.mode,
        stressYear: tipsLadderMaintenance.stressYear,
        rolledCount: tipsLadderMaintenance.rolledCount,
        rolledValue: round(tipsLadderMaintenance.rolledValue, 6),
        replenishedCount: tipsLadderMaintenance.replenishedCount,
        replenishedCost: round(tipsLadderMaintenance.replenishedCost, 6),
        shortfall: round(tipsLadderMaintenance.shortfall, 6)
      } : null
    } : null,
    allocationStrategy,
    assetLocation,
    unfunded: round(unfunded, 6),
    flows: flows.filter((flow) => flow.amount > 0),
    sales: finalWithdrawal.sales,
    accounts: accountBreakdown(portfolio),
    assets: endingAssets,
    // Slim summary instead of the full inflated profile: a Monte Carlo
    // 5k runs × 35 years was serializing the full brackets+state object
    // 175k times across the Web Worker boundary.
    taxProfileSummary: {
      filingStatus: yearTaxProfile.filingStatus,
      standardDeduction: yearTaxProfile.standardDeduction,
      enhancedSeniorDeduction: round(finalTaxes.enhancedSeniorDeduction ?? 0, 6),
      qualifyingChildren: yearTaxProfile.qualifyingChildren
    },
    filingStatus: yearTaxProfile.filingStatus
  };
}

function reconcileCashRequirement({
  portfolio,
  withdrawal,
  taxes,
  aca,
  medicare,
  taxableSocialSecurity,
  medicalEstimate,
  scenario,
  yearTaxProfile,
  yearAcaConfig,
  inflationIndex,
  medicalInflationIndex = null,
  plannedSpending,
  hsaContributionAmount = 0,
  dividends,
  incomeCashAvailable = 0,
  ordinaryIncome,
  earnedIncome = emptyEarnedIncome(),
  retirementOrdinaryIncome = 0,
  ordinaryInvestmentIncome = 0,
  qualifiedDividends = 0,
  adjustmentsToIncome = 0,
  strategyShortTermGains = 0,
  strategyLongTermGains = 0,
  strategyCapitalLosses = 0,
  strategyShortTermLosses = 0,
  strategyLongTermLosses = 0,
  lossCarryforward,
  socialSecurityBenefits,
  hsaQualifiedExpenseBalance = 0,
  age,
  ownerAges = null,
  spouseAge,
  yearIndex,
  calendarYear,
  magiHistory,
  sequenceRiskReserve,
  allocationStrategy
}) {
  let currentWithdrawal = withdrawal;
  let currentTaxes = taxes;
  let currentAca = aca;
  let currentMedicare = medicare ?? emptyMedicareCost();
  let currentTaxableSocialSecurity = taxableSocialSecurity ?? 0;
  let currentMedicalEstimate = medicalEstimate;
  let currentRothBasisOptimization = null;

  for (let iteration = 0; iteration < 10; iteration += 1) {
    const totalCashRequired = plannedSpending
      + (scenario.targetSpendIncludesMedical ? 0 : currentMedicalEstimate)
      + (scenario.targetSpendIncludesTaxes ? 0 : currentTaxes.totalTax)
      + hsaContributionAmount;
    const cashAvailable = dividends.cash + incomeCashAvailable + socialSecurityBenefits + currentWithdrawal.cashRaised;
    const gap = totalCashRequired - cashAvailable;
    if (gap <= CASH_GAP_TOLERANCE) break;

    const chosenTopUp = chooseWithdrawalPlan({
      portfolio,
      amount: gap,
      baseWithdrawal: currentWithdrawal,
      withdrawalOrder: scenario.withdrawalOrder,
      withdrawalContext: {
        age,
        ownerAges,
        calendarYear,
        penaltyAge: scenario.retirementPenaltyAge ?? 59.5,
        penaltyRate: scenario.earlyWithdrawalPenaltyRate ?? 0.1,
        rothBasisRemaining: currentWithdrawal.rothBasisRemaining,
        rothBasisAvailable: rothBasisAvailableForWithdrawal(portfolio, {
          rothBasisRemaining: currentWithdrawal.rothBasisRemaining,
          age,
          calendarYear,
          penaltyAge: scenario.retirementPenaltyAge ?? 59.5
        }),
        rothFiveYearRuleSatisfied: scenario.rothFiveYearRuleSatisfied !== false,
        penaltyExceptionRemaining: currentWithdrawal.penaltyExceptionRemaining,
        returnAssumptions: scenario.returnAssumptions,
        optimizedLotSelection: isLifetimeOptimizerEnabled(scenario) || sequenceRiskReserve?.enabled,
        sequenceRiskReserve,
        allocationStrategy,
        hsaQualifiedExpenseAvailable: hsaQualifiedExpenseAvailableForWithdrawal({
          scenario,
          hsaQualifiedExpenseBalance,
          medicalEstimate: currentMedicalEstimate
        }) - (currentWithdrawal.hsaQualifiedExpenseUsed ?? currentWithdrawal.hsaProceeds ?? 0)
      },
      evaluationContext: {
        scenario,
        yearTaxProfile,
        yearAcaConfig,
        inflationIndex,
        medicalInflationIndex: medicalInflationIndex ?? inflationIndex,
        ordinaryIncome,
        earnedIncome,
        retirementOrdinaryIncome,
        ordinaryInvestmentIncome,
        qualifiedDividends,
        adjustmentsToIncome,
        strategyShortTermGains,
        strategyLongTermGains,
        strategyCapitalLosses,
        strategyShortTermLosses,
        strategyLongTermLosses,
        lossCarryforward,
        socialSecurityBenefits,
        age,
        spouseAge,
        yearIndex,
        magiHistory
      }
    });
    if (chosenTopUp.withdrawal.cashRaised <= currentWithdrawal.cashRaised + CASH_RAISED_EPSILON) break;

    portfolio.splice(0, portfolio.length, ...chosenTopUp.portfolio);
    currentWithdrawal = chosenTopUp.withdrawal;
    currentTaxableSocialSecurity = chosenTopUp.taxableSocialSecurity;
    currentTaxes = chosenTopUp.taxes;
    currentAca = chosenTopUp.aca;
    currentMedicalEstimate = scenario.targetSpendIncludesMedical ? 0 : chosenTopUp.medicalTotal;
    currentMedicare = chosenTopUp.medicare;
    currentRothBasisOptimization = chosenTopUp.rothBasisOptimization;
  }

  for (let iteration = 0; iteration < 20; iteration += 1) {
    const totalCashRequired = plannedSpending
      + (scenario.targetSpendIncludesMedical ? 0 : currentMedicalEstimate)
      + (scenario.targetSpendIncludesTaxes ? 0 : currentTaxes.totalTax)
      + hsaContributionAmount;
    const cashAvailable = dividends.cash + incomeCashAvailable + socialSecurityBenefits + currentWithdrawal.cashRaised;
    const gap = totalCashRequired - cashAvailable;
    if (gap <= CASH_GAP_TOLERANCE) break;

    const forcedTopUp = evaluateWithdrawalPlan({
      portfolio,
      amount: gap,
      baseWithdrawal: currentWithdrawal,
      withdrawalOrder: forcedWithdrawalOrder(scenario.withdrawalOrder),
      withdrawalContext: {
        age,
        ownerAges,
        calendarYear,
        penaltyAge: scenario.retirementPenaltyAge ?? 59.5,
        penaltyRate: scenario.earlyWithdrawalPenaltyRate ?? 0.1,
        rothBasisRemaining: currentWithdrawal.rothBasisRemaining,
        rothFiveYearRuleSatisfied: scenario.rothFiveYearRuleSatisfied !== false,
        penaltyExceptionRemaining: currentWithdrawal.penaltyExceptionRemaining,
        returnAssumptions: scenario.returnAssumptions,
        optimizedLotSelection: false,
        // Last resort: the forced top-up may break future TIPS ladder rungs
        // (they sort last) rather than leave the year unfunded.
        includeTipsLadderRungs: true,
        maxRothProceeds: Infinity,
        hsaQualifiedExpenseAvailable: hsaQualifiedExpenseAvailableForWithdrawal({
          scenario,
          hsaQualifiedExpenseBalance,
          medicalEstimate: currentMedicalEstimate
        }) - (currentWithdrawal.hsaQualifiedExpenseUsed ?? currentWithdrawal.hsaProceeds ?? 0)
      },
      evaluationContext: {
        scenario,
        yearTaxProfile,
        yearAcaConfig,
        inflationIndex,
        medicalInflationIndex: medicalInflationIndex ?? inflationIndex,
        ordinaryIncome,
        earnedIncome,
        retirementOrdinaryIncome,
        ordinaryInvestmentIncome,
        qualifiedDividends,
        adjustmentsToIncome,
        strategyShortTermGains,
        strategyLongTermGains,
        strategyCapitalLosses,
        strategyShortTermLosses,
        strategyLongTermLosses,
        lossCarryforward,
        socialSecurityBenefits,
        age,
        spouseAge,
        yearIndex,
        magiHistory
      }
    });
    if (forcedTopUp.withdrawal.cashRaised <= currentWithdrawal.cashRaised + CASH_RAISED_EPSILON) break;

    portfolio.splice(0, portfolio.length, ...forcedTopUp.portfolio);
    currentWithdrawal = forcedTopUp.withdrawal;
    currentTaxableSocialSecurity = forcedTopUp.taxableSocialSecurity;
    currentTaxes = forcedTopUp.taxes;
    currentAca = forcedTopUp.aca;
    currentMedicalEstimate = scenario.targetSpendIncludesMedical ? 0 : forcedTopUp.medicalTotal;
    currentMedicare = forcedTopUp.medicare;
  }

  return {
    withdrawal: currentWithdrawal,
    taxes: currentTaxes,
    aca: currentAca,
    medicare: currentMedicare,
    taxableSocialSecurity: currentTaxableSocialSecurity,
    medicalEstimate: currentMedicalEstimate,
    rothBasisOptimization: currentRothBasisOptimization
  };
}

// Zero-filled year shape emitted after both lives have ended. Keeps
// plan.years.length === planYears so downstream UI (sliders, charts, audit
// bundles) doesn't have to special-case truncated plans. The portfolio is
// frozen — no returns, no spending, no taxes, no income. Flagged so charts
// can mask or annotate these rows. Field shapes intentionally mirror the
// live-year result (taxes.totalTax, medicare object, hsaContribution object,
// assetClassReturns map) so consumers never need postMortality-specific
// shape handling.
export function buildPostMortalityYearResult({ scenario, yearIndex, portfolio, inflationIndex }) {
  const calendarYear = (scenario.startYear ?? 0) + yearIndex;
  const frozenValue = portfolioValue(portfolio);
  return {
    year: calendarYear,
    yearIndex: yearIndex + 1,
    age: null,
    inflationIndex: round(inflationIndex, 6),
    beginningPortfolioValue: frozenValue,
    beginningAssets: [],
    assetClassReturns: summarizeAssetClassReturns({}, null),
    afterReturnPortfolioValue: frozenValue,
    endingPortfolioValue: frozenValue,
    plannedSpending: 0,
    spendingStrategy: { mode: "postMortality", discretionaryPercent: 0 },
    essentialSpending: 0,
    discretionarySpending: 0,
    discretionarySpendingBudget: 0,
    spendingGuardrail: null,
    medicalCost: 0,
    medicare: emptyMedicareCost(),
    ltcCost: 0,
    spendingPhase: null,
    age65AdditionalDeduction: 0,
    enhancedSeniorDeduction: 0,
    enhancedSeniorDeductionEligibleCount: 0,
    enhancedSeniorDeductionTaxYear: calendarYear,
    qualifyingChildren: 0,
    earnedIncome: 0,
    streamIncome: { cash: 0, ordinaryIncome: 0, retirementOrdinaryIncome: 0, taxFreeIncome: 0, details: [] },
    oneOffIncome: 0,
    oneOffExpenses: 0,
    oneOffIncomeDetails: [],
    oneOffExpenseDetails: [],
    medicareWages: 0,
    socialSecurityWages: null,
    selfEmploymentIncome: 0,
    rrtaCompensation: 0,
    socialSecurityBenefits: 0,
    taxableSocialSecurity: 0,
    rmdAmount: 0,
    rmdRequired: 0,
    rmdStartAge: null,
    rmdFactor: null,
    rmdBase: 0,
    rmdByOwner: null,
    cashRaised: 0,
    taxableDividendsCash: 0,
    taxableDividendDetails: [],
    cashAvailable: 0,
    unspentCash: 0,
    totalCashRequired: 0,
    taxes: {
      // Same key names as live-year computeIncomeTax output (zero-filled), so
      // `year.taxes.totalTax` style consumers never see undefined on stub years.
      totalTax: 0,
      incomeTax: 0,
      federalIncomeTax: 0,
      federalIncomeTaxBeforeCredits: 0,
      netFederalIncomeTaxAfterRefundableCredits: 0,
      federalRefundableCredits: 0,
      childTaxCredit: 0,
      additionalChildTaxCredit: 0,
      enhancedSeniorDeduction: 0,
      stateTax: 0,
      niitTax: 0,
      employeePayrollTax: 0,
      selfEmploymentTax: 0,
      additionalMedicareTax: 0,
      penaltyTax: 0,
      lossCarryforward: 0,
      lossCarryforwardShort: 0,
      lossCarryforwardLong: 0
    },
    taxAttribution: null,
    aca: null,
    acaMagiCeiling: null,
    acaMagiCeilingFplPercent: null,
    federalAgi: 0,
    acaMagi: 0,
    irmaaMagi: 0,
    magi: 0,
    realizedLongTermGains: 0,
    taxGainHarvested: 0,
    realizedShortTermGains: 0,
    realizedCapitalLosses: 0,
    lossCarryforward: 0,
    lossCarryforwardDetail: { shortTerm: 0, longTerm: 0 },
    rothConversionAmount: 0,
    penaltyTax: 0,
    penaltyBase: 0,
    penaltyExceptionUsed: 0,
    penaltyExceptionRemaining: 0,
    rothWithdrawals: 0,
    rothBasisUsed: 0,
    rothBasisRemaining: 0,
    rothContributionBasisRemaining: 0,
    rothConversionPrincipalRemaining: 0,
    rothPenaltyFreeConversionPrincipal: 0,
    rothBasisAvailable: 0,
    rothFiveYearRuleSatisfied: scenario.rothFiveYearRuleSatisfied !== false,
    rothBasisOptimization: null,
    hsaContribution: emptyHsaContribution(hsaStrategyConfig(scenario)),
    hsaWithdrawals: 0,
    hsaQualifiedExpenseBalance: 0,
    sequenceRiskReserve: null,
    tipsLadder: null,
    allocationStrategy: null,
    assetLocation: null,
    unfunded: 0,
    flows: [],
    sales: [],
    accounts: accountBreakdown(portfolio),
    assets: [],
    taxProfileSummary: { filingStatus: null, standardDeduction: 0, enhancedSeniorDeduction: 0, qualifyingChildren: 0 },
    filingStatus: null,
    postMortality: true
  };
}
