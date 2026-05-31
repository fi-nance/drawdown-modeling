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
  assert.ok(report.flags.some((flag) => flag.id === "legacy-tax-out-of-model" && flag.level === CONFIDENCE_LEVELS.OUT_OF_MODEL));
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
        zip: "02139",
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
