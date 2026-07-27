/**
 * TelematiX Plant (Yellow-Metal) and Agri rating engines.
 *
 * Ported from TelematiX_Plant_Ingestion_Matrix.xlsx and
 * TelematiX_Agri_Ingestion_Matrix.xlsx (received from Frans, 13 July 2026).
 * Weighted-coverage formula validated to match every scenario number in
 * both workbooks exactly (Plant: 0.602 / 0.945; Agri combine 0.639/0.919,
 * tractor 0.629/0.899, sprayer 0.671/0.873) before being ported here.
 *
 * IMPORTANT SCOPE NOTE: both workbooks model exactly two discrete
 * data-source scenarios each (not a continuous partial-fitment slider).
 * "oemOnly" and "svrFitted" (Plant) / "fullFit" (Agri) are the only two
 * fitment states this engine supports -- faithful to what's actually
 * validated in the spreadsheets. A more granular model (e.g. suppression
 * fitted but no SVR) would need a fresh confirmed spec from Frans.
 *
 * Base rate model differs from HCV: Premium = machine value x
 * application base rate (declared use class), NOT sum-insured x
 * asset-class-base-rate x fleet-size-multiplier x market-loadings.
 * Uses the existing ASSET_CLASS_BASE_RATE entries ("Yellow metal / plant"
 * = 2.0%, "Agricultural equipment" = 1.6%) as the application base rate,
 * pending Frans confirming these are the correct per-machine-type figures
 * (the workbooks do not specify base rates, only the coverage/gate model
 * that produces the rating-factor MODIFIER on top of that base).
 */

// ---------------------------------------------------------------------------
// Shared qualifier band lookup (identical structure, both engines)
// ---------------------------------------------------------------------------
// Ascending coverage floor -> rating-factor floor. A factor of 2 signals
// REFER/DECLINE (below 50% visibility), matching the existing app-wide
// pattern of an explicit non-priceable verdict rather than a guessed number.
const QUALIFIER_BANDS = [
  { floor: 0.0, factor: 2.0, profile: "Data-blind / refer" },
  { floor: 0.5, factor: 1.4, profile: "Profile B (partial-visibility)" },
  { floor: 0.7, factor: 1.1, profile: "Profile B (upper)" },
  { floor: 0.9, factor: 0.7, profile: "Profile A eligible" },
];

function bandForCoverage(coverage) {
  let best = QUALIFIER_BANDS[0];
  for (const b of QUALIFIER_BANDS) {
    if (coverage >= b.floor) best = b;
  }
  return best;
}

const GATE_CAP_FACTOR = 1.4;
const GATE_CAP_PROFILE = "Profile B (partial-visibility)";

// Applies the qualifier band, then any active-and-failed gates, and returns
// the MORE CONSERVATIVE (higher factor = worse) of the two, per both
// workbooks' explicit "applied floor" rule.
function applyQualifier(coverage, gateResults) {
  const band = bandForCoverage(coverage);
  let factor = band.factor;
  let profile = band.profile;
  for (const gate of gateResults) {
    if (gate.active && !gate.cleared && GATE_CAP_FACTOR > factor) {
      factor = GATE_CAP_FACTOR;
      profile = GATE_CAP_PROFILE;
    }
  }
  return { coverage: Math.round(coverage * 1000) / 1000, factor, profile };
}

// ---------------------------------------------------------------------------
// PLANT / YELLOW-METAL
// ---------------------------------------------------------------------------
export const PLANT_FACTOR_WEIGHTS = {
  theftSecurity: 0.50,
  utilisation: 0.10,
  machineHealth: 0.10,
  operatorAbuse: 0.08,
  afterHoursUse: 0.08,
  siteTransitExposure: 0.09,
  applicationVerification: 0.05,
};

export const PLANT_COVERAGE_OEM_ONLY = {
  theftSecurity: 0.4, utilisation: 1, machineHealth: 1, operatorAbuse: 0.5,
  afterHoursUse: 0.8, siteTransitExposure: 0.7, applicationVerification: 0.7,
};
export const PLANT_COVERAGE_OEM_SVR = {
  theftSecurity: 1, utilisation: 1, machineHealth: 1, operatorAbuse: 0.5,
  afterHoursUse: 1, siteTransitExposure: 1, applicationVerification: 0.7,
};

export const PLANT_THEFT_GATE_THRESHOLD = 0.9;

// dataSource: "oemOnly" | "oemSvr"
export function computePlantRatingFactor(dataSource) {
  const cov = dataSource === "oemSvr" ? PLANT_COVERAGE_OEM_SVR : PLANT_COVERAGE_OEM_ONLY;
  const overallCoverage = Object.keys(PLANT_FACTOR_WEIGHTS).reduce(
    (sum, k) => sum + PLANT_FACTOR_WEIGHTS[k] * cov[k], 0
  );
  const theftGateCleared = cov.theftSecurity >= PLANT_THEFT_GATE_THRESHOLD;
  return applyQualifier(overallCoverage, [
    { name: "theftSecurity", active: true, cleared: theftGateCleared },
  ]);
}

// ---------------------------------------------------------------------------
// AGRI (per-machine-type weights, dual gates)
// ---------------------------------------------------------------------------
export const AGRI_MACHINE_TYPES = ["combine", "tractor", "sprayer"];

export const AGRI_FACTOR_WEIGHTS = {
  combine: { fire: 0.25, theft: 0.20, machineHealth: 0.15, seasonality: 0.10, operatorCompetence: 0.10, utilisation: 0.08, weatherTerrain: 0.07, transitExposure: 0.05 },
  tractor: { fire: 0.10, theft: 0.30, machineHealth: 0.12, seasonality: 0.05, operatorCompetence: 0.12, utilisation: 0.09, weatherTerrain: 0.12, transitExposure: 0.10 },
  sprayer: { fire: 0.10, theft: 0.18, machineHealth: 0.15, seasonality: 0.07, operatorCompetence: 0.12, utilisation: 0.08, weatherTerrain: 0.20, transitExposure: 0.10 },
};

export const AGRI_COVERAGE_OEM_ONLY = {
  fire: 0.5, theft: 0.4, machineHealth: 1, seasonality: 0.7,
  operatorCompetence: 0.5, utilisation: 1, weatherTerrain: 0.7, transitExposure: 0.7,
};
export const AGRI_COVERAGE_FULL_FIT = {
  fire: 1, theft: 1, machineHealth: 1, seasonality: 0.9,
  operatorCompetence: 0.5, utilisation: 1, weatherTerrain: 0.7, transitExposure: 1,
};

// Both gates active for all three machine types (Frans's workbook, Qualifier
// sheet: Fire gate / Theft gate columns are Y/Y for combine, tractor, sprayer).
export const AGRI_FIRE_GATE_THRESHOLD = null; // gate is presence/absence of suppression, not a coverage %
export const AGRI_THEFT_GATE_THRESHOLD = null; // gate is presence/absence of SVR, not a coverage %

// machineType: "combine" | "tractor" | "sprayer"
// dataSource: "oemOnly" (no suppression, no SVR) | "fullFit" (suppression + SVR fitted)
export function computeAgriRatingFactor(machineType, dataSource) {
  if (!AGRI_MACHINE_TYPES.includes(machineType)) {
    throw new Error(`computeAgriRatingFactor: unknown machine type '${machineType}'`);
  }
  const weights = AGRI_FACTOR_WEIGHTS[machineType];
  const cov = dataSource === "fullFit" ? AGRI_COVERAGE_FULL_FIT : AGRI_COVERAGE_OEM_ONLY;
  const overallCoverage = Object.keys(weights).reduce(
    (sum, k) => sum + weights[k] * cov[k], 0
  );
  const suppressionFitted = dataSource === "fullFit";
  const svrFitted = dataSource === "fullFit";
  return applyQualifier(overallCoverage, [
    { name: "fireSuppression", active: true, cleared: suppressionFitted },
    { name: "theftSecurity", active: true, cleared: svrFitted },
  ]);
}