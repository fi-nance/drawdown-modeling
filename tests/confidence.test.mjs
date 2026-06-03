import assert from "node:assert/strict";
import test from "node:test";

import {
  CONFIDENCE_LEVELS,
  actionConfidenceFor,
  buildConfidenceReport,
  confidenceLevelLabel,
  rescueConfidenceFor
} from "../src/core/confidence.mjs";

test("confidence report flags input-limited ACA estimates and legacy gaps", () => {
  const report = buildConfidenceReport({
    scenario: {
      aca: {
        enabled: true,
        planCostMode: "stateBenchmark",
        premiumInputMode: "gross",
        manualOopMaximum: false
      }
    },
    taxProfile: {
      state: {
        source: "Tax Foundation 2026 state income tax compilation",
        retirementRulesSource: "Best-effort 2026 state retirement-income rule table; verify against state instructions before filing."
      }
    }
  });

  assert.equal(report.headline, "CPA review recommended");
  assert.ok(report.flags.some((flag) => flag.id === "aca-plan-inputs" && flag.level === CONFIDENCE_LEVELS.INPUT_LIMITED));
  assert.ok(report.flags.some((flag) => flag.id === "state-retirement-tax-review" && flag.level === CONFIDENCE_LEVELS.CPA_REVIEW));
  assert.ok(report.flags.some((flag) => flag.id === "legacy-tax-out-of-model" && flag.level === CONFIDENCE_LEVELS.CPA_REVIEW));
});

test("confidence report labels opt-in Social Security PIA estimator as input-limited", () => {
  const report = buildConfidenceReport({
    scenario: {
      estimateSocialSecurityFromEarnings: true,
      socialSecurityAnnualBenefit: 0,
      medicareWages: 120000
    }
  });

  const flag = report.flags.find((item) => item.id === "social-security-claiming-inputs");
  assert.ok(flag);
  assert.equal(flag.level, CONFIDENCE_LEVELS.INPUT_LIMITED);
  assert.match(flag.detail, /2026 SSA PIA bend points/);
  assert.match(flag.detail, /career-average AIME/);
});

test("confidence report flags self-employment income as business-income CPA review", () => {
  const report = buildConfidenceReport({
    scenario: {
      aca: { enabled: false },
      selfEmploymentIncome: 50_000
    }
  });

  const flag = report.flags.find((item) => item.id === "business-income-tax-review");
  assert.ok(flag);
  assert.equal(flag.level, CONFIDENCE_LEVELS.CPA_REVIEW);
  assert.match(flag.detail, /Schedule SE/);
  assert.match(flag.detail, /QBI\/Form 8995/);
  assert.match(flag.detail, /AMT/);
  assert.match(flag.detail, /\$50,000 annual self-employment income/);
  assert.equal(actionConfidenceFor("earnedIncome", report).level, CONFIDENCE_LEVELS.CPA_REVIEW);
});

test("confidence report flags scheduled self-employment bridge income", () => {
  const report = buildConfidenceReport({
    scenario: {
      aca: { enabled: false },
      oneOffExpenses: [{
        name: "Decision engine income bridge",
        cashFlowType: "selfEmploymentIncome",
        startYear: 1,
        endYear: 2,
        amount: 40_000,
        inflationAdjusted: false
      }]
    }
  });

  const flag = report.flags.find((item) => item.id === "business-income-tax-review");
  assert.ok(flag);
  assert.match(flag.detail, /\$40,000 scheduled self-employment bridge income/);
});

test("confidence report names rating-area SLCSP when ZIP lookup succeeds", () => {
  const report = buildConfidenceReport({
    scenario: {
      aca: {
        enabled: true,
        planCostMode: "stateBenchmark",
        premiumInputMode: "gross",
        manualOopMaximum: true,
        year: 2026,
        zip: "33101",
        currentAge: 40,
        memberAges: [40]
      }
    }
  });

  const flag = report.flags.find((item) => item.id === "aca-rating-area-slcsp");
  assert.ok(flag);
  assert.equal(flag.level, CONFIDENCE_LEVELS.HIGH);
  assert.match(flag.detail, /ZIP 33101/);
  assert.match(flag.detail, /rating area 43/);
  assert.match(flag.detail, /second-lowest-cost silver/i);
});

test("confidence report explains state fallback when ZIP is not bundled", () => {
  const report = buildConfidenceReport({
    scenario: {
      aca: {
        enabled: true,
        planCostMode: "stateBenchmark",
        premiumInputMode: "gross",
        manualOopMaximum: true,
        year: 2026,
        zip: "60601",
        currentAge: 40,
        memberAges: [40]
      }
    }
  });

  const flag = report.flags.find((item) => item.id === "aca-benchmark-state-fallback");
  assert.ok(flag);
  assert.equal(flag.level, CONFIDENCE_LEVELS.INPUT_LIMITED);
  assert.match(flag.detail, /state-level SLCSP fallback/);
  assert.match(flag.action, /state exchange|Marketplace API/);
});

test("confidence report flags out-of-model ACA ZIPs", () => {
  const report = buildConfidenceReport({
    scenario: {
      aca: {
        enabled: true,
        planCostMode: "stateBenchmark",
        premiumInputMode: "gross",
        manualOopMaximum: true,
        year: 2026,
        zip: "00901",
        currentAge: 40,
        memberAges: [40]
      }
    }
  });

  const flag = report.flags.find((item) => item.id === "aca-benchmark-out-of-model");
  assert.ok(flag);
  assert.equal(flag.level, CONFIDENCE_LEVELS.OUT_OF_MODEL);
  assert.match(flag.detail, /out of model|does not resolve/i);
});

test("confidence reports HIGH rating-area SLCSP for a ZIP3-resolved SBE state, without claiming CMS-PUF provenance", () => {
  const report = buildConfidenceReport({
    scenario: {
      aca: {
        enabled: true,
        planCostMode: "stateBenchmark",
        premiumInputMode: "gross",
        manualOopMaximum: true,
        year: 2026,
        zip: "90012", // Los Angeles → Covered California rating area 15
        currentAge: 40,
        memberAges: [40]
      }
    }
  });

  const flag = report.flags.find((item) => item.id === "aca-rating-area-slcsp");
  assert.ok(flag);
  assert.equal(flag.level, CONFIDENCE_LEVELS.HIGH);
  assert.match(flag.detail, /CA rating area 15/);
  assert.match(flag.detail, /SBE Public Rate Bulletins/);
  // SBE data is not from the CMS PUFs; the copy must not claim it is.
  assert.doesNotMatch(flag.detail, /CMS/);
});

test("confidence reports a state fallback for default-only SBE states (no phantom rating area)", () => {
  const report = buildConfidenceReport({
    scenario: {
      aca: {
        enabled: true,
        planCostMode: "stateBenchmark",
        premiumInputMode: "gross",
        manualOopMaximum: true,
        year: 2026,
        zip: "02139", // Massachusetts: SBE-covered but default-only (no rating-area map)
        currentAge: 40,
        memberAges: [40]
      }
    }
  });

  const flag = report.flags.find((item) => item.id === "aca-benchmark-state-fallback");
  assert.ok(flag, "default-only SBE state should be an honest state fallback, not HIGH confidence");
  assert.equal(flag.level, CONFIDENCE_LEVELS.INPUT_LIMITED);
});

test("confidence report flags evidence disagreement and narrow ACA MAGI buffers", () => {
  const report = buildConfidenceReport({
    scenario: {
      aca: {
        enabled: true,
        planCostMode: "selectedPlan",
        premiumInputMode: "gross",
        manualOopMaximum: true
      }
    },
    decision: {
      status: "ready",
      base: {
        historical: { count: 12 },
        verdict: {
          historicalKnown: true,
          monteCarloPasses: true,
          historicalPasses: false
        }
      },
      healthcare: { magiBuffer: 900 }
    }
  });

  assert.ok(report.flags.some((flag) => flag.id === "evidence-disagreement" && flag.level === CONFIDENCE_LEVELS.ASSUMPTION_SENSITIVE));
  assert.ok(report.flags.some((flag) => flag.id === "aca-magi-threshold" && flag.detail.includes("$900")));
});

test("action confidence maps action types to relevant review flags", () => {
  const report = buildConfidenceReport({
    scenario: {
      aca: {
        enabled: true,
        planCostMode: "stateBenchmark",
        premiumInputMode: "gross",
        manualOopMaximum: false
      },
      socialSecurityAnnualBenefit: 24_000
    },
    taxProfile: {
      state: {
        retirementRulesSource: "Best-effort 2026 state retirement-income rule table; verify against state instructions before filing."
      }
    },
    decision: {
      status: "ready",
      base: { historical: { count: 5 }, verdict: { historicalKnown: true, monteCarloPasses: true, historicalPasses: true } },
      healthcare: { magiBuffer: 800 }
    }
  });

  assert.equal(actionConfidenceFor("magiManagement", report).level, CONFIDENCE_LEVELS.ASSUMPTION_SENSITIVE);
  assert.equal(actionConfidenceFor("medicalReserve", report).level, CONFIDENCE_LEVELS.INPUT_LIMITED);
  assert.equal(actionConfidenceFor("traditionalWithdrawal", report).level, CONFIDENCE_LEVELS.CPA_REVIEW);
  assert.equal(actionConfidenceFor("socialSecurity", report).level, CONFIDENCE_LEVELS.INPUT_LIMITED);
  assert.equal(actionConfidenceFor("fundingGap", report).level, CONFIDENCE_LEVELS.ASSUMPTION_SENSITIVE);
  assert.equal(actionConfidenceFor("taxLossHarvesting", report).level, CONFIDENCE_LEVELS.HIGH);
});

test("rescue confidence maps rescue options to relevant review flags", () => {
  const acaReport = buildConfidenceReport({
    scenario: {
      aca: {
        enabled: true,
        planCostMode: "selectedPlan",
        premiumInputMode: "gross",
        manualOopMaximum: true
      }
    },
    decision: {
      status: "ready",
      base: { historical: { count: 10 }, verdict: { historicalKnown: true, monteCarloPasses: true, historicalPasses: true } },
      healthcare: { magiBuffer: 700 }
    }
  });

  const ssReport = buildConfidenceReport({
    scenario: {
      aca: { enabled: false },
      socialSecurityAnnualBenefit: 30_000
    },
    decision: {
      status: "ready",
      base: { historical: { count: 10 }, verdict: { historicalKnown: true, monteCarloPasses: true, historicalPasses: true } }
    }
  });

  assert.equal(
    rescueConfidenceFor({ kind: "conversionGuardrail", historical: { count: 10 } }, acaReport).level,
    CONFIDENCE_LEVELS.ASSUMPTION_SENSITIVE
  );
  assert.equal(
    rescueConfidenceFor({ kind: "socialSecurityBridge", historical: { count: 10 } }, ssReport).level,
    CONFIDENCE_LEVELS.INPUT_LIMITED
  );
  assert.equal(
    rescueConfidenceFor({ kind: "allocationShift", historical: { count: 10 } }, acaReport).level,
    CONFIDENCE_LEVELS.ASSUMPTION_SENSITIVE
  );
  assert.equal(
    rescueConfidenceFor({ kind: "incomeBridge", historical: { count: 10 } }, acaReport).level,
    CONFIDENCE_LEVELS.HIGH
  );
  assert.equal(
    rescueConfidenceFor({
      kind: "incomeBridge",
      historical: { count: 10 },
      scenario: {
        oneOffExpenses: [{
          name: "Decision engine income bridge",
          cashFlowType: "selfEmploymentIncome",
          amount: 50_000,
          startYear: 1,
          endYear: 2
        }]
      }
    }, acaReport).level,
    CONFIDENCE_LEVELS.CPA_REVIEW
  );
});

test("rescue confidence identifies preliminary and discarded candidates", () => {
  const report = buildConfidenceReport({
    scenario: { aca: { enabled: false } },
    decision: {
      status: "ready",
      base: { historical: { count: 10 }, verdict: { historicalKnown: true, monteCarloPasses: true, historicalPasses: true } }
    }
  });

  const preliminary = rescueConfidenceFor({ kind: "safeSpending", historical: { count: 0 } }, report);
  assert.equal(preliminary.level, CONFIDENCE_LEVELS.ASSUMPTION_SENSITIVE);
  assert.match(preliminary.title, /Preliminary/);

  const discarded = rescueConfidenceFor({ kind: "safeSpending", status: "discarded", historical: { count: 10 } }, report);
  assert.equal(discarded.level, CONFIDENCE_LEVELS.ASSUMPTION_SENSITIVE);
  assert.match(discarded.title, /negligible effect/i);
});

test("confidence report explains missing historical evidence with coverage context", () => {
  const report = buildConfidenceReport({
    scenario: { aca: { enabled: false } },
    decision: {
      status: "ready",
      base: {
        historical: { count: 0 },
        verdict: { historicalKnown: false }
      }
    },
    historicalCoverage: { startYear: 2011, endYear: 2025 },
    historicalAssetClasses: ["stock", "crypto"]
  });

  const flag = report.flags.find((item) => item.id === "historical-evidence-missing");
  assert.ok(flag);
  assert.match(flag.action, /2011-2025/);
  assert.match(flag.action, /stock, crypto/);
});

test("confidence level labels are stable for UI copy", () => {
  assert.equal(confidenceLevelLabel(CONFIDENCE_LEVELS.HIGH), "High confidence");
  assert.equal(confidenceLevelLabel(CONFIDENCE_LEVELS.INPUT_LIMITED), "Input-limited");
  assert.equal(confidenceLevelLabel(CONFIDENCE_LEVELS.CPA_REVIEW), "CPA review recommended");
});

test("coverage-gap flag fires for non-expansion states with ACA on", () => {
  const report = buildConfidenceReport({
    scenario: {
      state: "Texas",
      aca: {
        enabled: true,
        planCostMode: "selectedPlan",
        premiumInputMode: "gross",
        manualOopMaximum: true
      }
    }
  });
  const flag = report.flags.find((item) => item.id === "aca-coverage-gap-risk");
  assert.ok(flag, "Texas should trigger a coverage-gap flag");
  assert.equal(flag.level, CONFIDENCE_LEVELS.ASSUMPTION_SENSITIVE);
  assert.match(flag.detail, /Texas/);
  assert.match(flag.detail, /100% FPL/);
});

test("coverage-gap flag names modeled years below the PTC floor", () => {
  const report = buildConfidenceReport({
    scenario: {
      state: "Texas",
      aca: {
        enabled: true,
        planCostMode: "selectedPlan",
        premiumInputMode: "gross",
        manualOopMaximum: true
      }
    },
    plan: {
      years: [
        { year: 2026, aca: { fplPercent: 92, grossPremium: 12000, netPremium: 12000, subsidy: 0 }, medicalCost: 12000 },
        { year: 2027, aca: { fplPercent: 101, grossPremium: 12300, netPremium: 4000, subsidy: 8300 }, medicalCost: 4000 },
        { year: 2028, aca: { fplPercent: 88.4, grossPremium: 12600, netPremium: 12600, subsidy: 0 }, medicalCost: 12600 }
      ]
    }
  });

  const modeled = report.flags.find((item) => item.id === "aca-coverage-gap-modeled");
  assert.ok(modeled);
  assert.equal(modeled.level, CONFIDENCE_LEVELS.CPA_REVIEW);
  assert.match(modeled.detail, /2026 \(92% FPL\)/);
  assert.match(modeled.detail, /2028 \(88\.4% FPL\)/);
  assert.equal(report.flags.find((item) => item.id === "aca-coverage-gap-risk"), undefined);
  assert.equal(actionConfidenceFor("rothConversion", report).level, CONFIDENCE_LEVELS.CPA_REVIEW);
  assert.equal(
    rescueConfidenceFor({ kind: "conversionGuardrail", historical: { count: 5 } }, report).level,
    CONFIDENCE_LEVELS.CPA_REVIEW
  );
});

test("coverage-gap flag does not fire when modeled non-expansion years stay above the PTC floor", () => {
  const report = buildConfidenceReport({
    scenario: {
      state: "Texas",
      aca: {
        enabled: true,
        planCostMode: "selectedPlan",
        premiumInputMode: "gross",
        manualOopMaximum: true
      }
    },
    plan: {
      years: [
        { year: 2026, aca: { fplPercent: 125, grossPremium: 12000, netPremium: 2400, subsidy: 9600 }, medicalCost: 2400 },
        { year: 2027, aca: { fplPercent: 150, grossPremium: 12300, netPremium: 3600, subsidy: 8700 }, medicalCost: 3600 }
      ]
    }
  });

  assert.equal(report.flags.find((item) => item.id === "aca-coverage-gap-modeled"), undefined);
  assert.equal(report.flags.find((item) => item.id === "aca-coverage-gap-risk"), undefined);
});

test("expanded states flag modeled Medicaid/CHIP handoff years below 138 percent FPL", () => {
  const report = buildConfidenceReport({
    scenario: {
      state: "Massachusetts",
      aca: {
        enabled: true,
        planCostMode: "selectedPlan",
        premiumInputMode: "gross",
        manualOopMaximum: true
      }
    },
    plan: {
      years: [
        { year: 2026, aca: { fplPercent: 132.6, grossPremium: 9000, netPremium: 1200, subsidy: 7800 }, medicalCost: 1200 },
        { year: 2027, aca: { fplPercent: 160, grossPremium: 9300, netPremium: 2200, subsidy: 7100 }, medicalCost: 2200 }
      ]
    }
  });

  const flag = report.flags.find((item) => item.id === "aca-medicaid-handoff-modeled");
  assert.ok(flag);
  assert.equal(flag.level, CONFIDENCE_LEVELS.ASSUMPTION_SENSITIVE);
  assert.match(flag.detail, /2026 \(132\.6% FPL\)/);
  assert.match(flag.action, /Medicaid\/CHIP/);
});

test("coverage-gap flag fires with partial-expansion language for Georgia", () => {
  const report = buildConfidenceReport({
    scenario: {
      state: "Georgia",
      aca: {
        enabled: true,
        planCostMode: "selectedPlan",
        premiumInputMode: "gross",
        manualOopMaximum: true
      }
    }
  });
  const flag = report.flags.find((item) => item.id === "aca-coverage-gap-risk");
  assert.ok(flag);
  assert.match(flag.detail, /partial Medicaid expansion/);
  assert.match(flag.detail, /§1115/);
});

test("coverage-gap flag does NOT fire for expansion states", () => {
  const report = buildConfidenceReport({
    scenario: {
      state: "Massachusetts",
      aca: {
        enabled: true,
        planCostMode: "selectedPlan",
        premiumInputMode: "gross",
        manualOopMaximum: true
      }
    }
  });
  const flag = report.flags.find((item) => item.id === "aca-coverage-gap-risk");
  assert.equal(flag, undefined);
});

test("coverage-gap flag is suppressed when ACA is disabled", () => {
  const report = buildConfidenceReport({
    scenario: {
      state: "Texas",
      aca: { enabled: false }
    }
  });
  const flag = report.flags.find((item) => item.id === "aca-coverage-gap-risk");
  assert.equal(flag, undefined);
});
