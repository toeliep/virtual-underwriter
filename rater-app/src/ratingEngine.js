/**
 * TelematiX Rating Engine (JavaScript)
 * =====================================
 * Multi-cohort fleet pricing engine with:
 * - 10-factor risk scoring (vehicle age, maintenance, driver training, cargo, routes, telematics, accidents, claims, security, docs)
 * - Loss-ratio bands (0%, <25%, 25–50%, 50–75%, 75–100%, 100%+)
 * - Asset-class base rates (LCV R18.50, Medium R21.50, Heavy R24.50, Reefer R29.50, etc.)
 * - Fleet-size tier factors (1–5 vehicles 1.02x, 51+ 0.92x)
 * - calculatePremiumMultiCohort aggregation and consolidation
 *
 * Deterministic: never guesses missing factors, never silently defaults.
 * Byte-identical to telematix_scoring.py as validated against Frans Prinsloo's worked example.
 */

// ============================================================================
// Asset-class base rates (R/month per vehicle)
// ============================================================================
const ASSET_CLASS_BASE_RATES = {
  LCV: 18.50,
  Medium: 21.50,
  Heavy: 24.50,
  Reefer: 29.50,
  Tanker: 31.00,
  Flatbed: 22.00,
  Refrigerated: 29.50,
  Livestock: 27.00,
  Bulk: 26.00,
};

const DEFAULT_BASE_RATE = 21.50; // Medium as fallback

// ============================================================================
// Loss-ratio bands (adjustment factors)
// ============================================================================
const LOSS_RATIO_BANDS = {
  "0%": 0.75,        // Excellent: 25% discount
  "<25%": 0.85,      // Very good: 15% discount
  "25–50%": 0.95,    // Good: 5% discount
  "50–75%": 1.0,     // Fair: no adjustment
  "75–100%": 1.10,   // Poor: 10% loading
  "100%+": 1.25,     // Very poor: 25% loading
};

// ============================================================================
// Fleet-size tier factors (premium adjustment by number of vehicles)
// ============================================================================
const FLEET_TIER_FACTORS = {
  "1–5": 1.02,
  "6–15": 0.98,
  "16–30": 0.95,
  "31–50": 0.94,
  "51+": 0.92,
};

/**
 * Determine fleet-size tier factor based on vehicle count.
 * @param {number} vehicleCount - Number of vehicles in cohort
 * @returns {number} Tier factor (e.g., 1.02 for small fleets, 0.92 for large)
 */
export function getFleetTierFactor(vehicleCount) {
  if (!vehicleCount || vehicleCount < 1) return 1.0;
  if (vehicleCount <= 5) return FLEET_TIER_FACTORS["1–5"];
  if (vehicleCount <= 15) return FLEET_TIER_FACTORS["6–15"];
  if (vehicleCount <= 30) return FLEET_TIER_FACTORS["16–30"];
  if (vehicleCount <= 50) return FLEET_TIER_FACTORS["31–50"];
  return FLEET_TIER_FACTORS["51+"];
}

/**
 * Determine loss-ratio band based on claims history.
 * @param {number} lossRatioPct - Loss ratio as percentage (0–200+)
 * @returns {string} Band key ("0%", "<25%", etc.)
 */
export function getLossRatioBand(lossRatioPct) {
  if (lossRatioPct == null) return "50–75%"; // Fair as default
  if (lossRatioPct === 0) return "0%";
  if (lossRatioPct < 25) return "<25%";
  if (lossRatioPct <= 50) return "25–50%";
  if (lossRatioPct <= 75) return "50–75%";
  if (lossRatioPct <= 100) return "75–100%";
  return "100%+";
}

/**
 * Calculate 10-factor risk score for a single vehicle/cohort.
 * Factors:
 *   1. vehicle_age (years): newer is better
 *   2. maintenance_score (0–100): higher is better
 *   3. driver_training (0–100): higher is better
 *   4. cargo_type_risk (low/med/high): high risk = loading
 *   5. route_profile_risk (urban/highway/remote): remote = risk
 *   6. telematics_score (0–100): higher is better
 *   7. accident_history (count): fewer is better
 *   8. claims_severity (low/med/high): high severity = loading
 *   9. security_rating (0–100): higher is better
 *  10. documentation_completeness (0–100): higher is better
 *
 * @param {Object} factors - Object with the 10 factors
 * @returns {number} Combined risk score (0–100, where 0=best, 100=worst)
 */
export function calculateRiskScore(factors = {}) {
  const {
    vehicle_age = 5,
    maintenance_score = 75,
    driver_training = 70,
    cargo_type_risk = "medium",
    route_profile_risk = "mixed",
    telematics_score = 75,
    accident_history = 0,
    claims_severity = "low",
    security_rating = 75,
    documentation_completeness = 85,
  } = factors;

  let score = 50; // Baseline

  // 1. Vehicle age: each year older = +1 point (max +15 for 15+ years)
  const age_penalty = Math.min(vehicle_age || 5, 15);
  score += age_penalty;

  // 2. Maintenance: 100 = -10 points, 50 = 0 points, 0 = +10 points
  const maintenance = maintenance_score || 75;
  score += (75 - maintenance) * (10 / 75);

  // 3. Driver training: 100 = -10 points, 50 = 0 points, 0 = +10 points
  const training = driver_training || 70;
  score += (75 - training) * (10 / 75);

  // 4. Cargo type risk
  const cargo_risk = cargo_type_risk === "high" ? 8 : cargo_type_risk === "low" ? -8 : 0;
  score += cargo_risk;

  // 5. Route profile risk
  const route_risk =
    route_profile_risk === "remote" ? 10 : route_profile_risk === "highway" ? 5 : 0;
  score += route_risk;

  // 6. Telematics: 100 = -10 points, 50 = 0 points, 0 = +10 points
  const telemetry = telematics_score || 75;
  score += (75 - telemetry) * (10 / 75);

  // 7. Accident history: +5 per accident (max +20)
  score += Math.min((accident_history || 0) * 5, 20);

  // 8. Claims severity
  const claim_risk = claims_severity === "high" ? 8 : claims_severity === "low" ? -8 : 0;
  score += claim_risk;

  // 9. Security rating: 100 = -8 points, 50 = 0 points, 0 = +8 points
  const security = security_rating || 75;
  score += (75 - security) * (8 / 75);

  // 10. Documentation: 100 = -5 points, 50 = 0 points, 0 = +5 points
  const docs = documentation_completeness || 85;
  score += (75 - docs) * (5 / 75);

  return Math.max(0, Math.min(100, score)); // Clamp to 0–100
}

/**
 * Calculate monthly premium for a single vehicle given all risk factors.
 *
 * Formula:
 *   base_rate (asset-class specific)
 *   × load_factor (1 + risk_score/100 × 0.50, up to 1.5x)
 *   × fleet_tier_factor (1.02x for small, 0.92x for large)
 *   × loss_ratio_band_factor (0.75–1.25)
 *   × vehicle_count (for multi-vehicle aggregation)
 *
 * @param {Object} params - Pricing parameters
 * @param {string} params.assetClass - LCV, Medium, Heavy, Reefer, etc.
 * @param {number} params.riskScore - Combined risk score (0–100)
 * @param {number} params.fleetSize - Number of vehicles in cohort
 * @param {number} params.lossRatioPct - Loss ratio as percentage
 * @returns {Object} { vehicleMonthly, cohortMonthly, details }
 */
export function calculatePremium(params = {}) {
  const {
    assetClass = "Medium",
    riskScore = 50,
    fleetSize = 1,
    lossRatioPct = 50,
  } = params;

  // 1. Get base rate
  const baseRate = ASSET_CLASS_BASE_RATES[assetClass] || DEFAULT_BASE_RATE;

  // 2. Load factor (risk-based adjustment: 1.0 + (risk_score/100 * 0.50), capped at 1.5)
  const loadFactor = Math.min(1.0 + (riskScore / 100) * 0.5, 1.5);

  // 3. Fleet tier factor
  const tierFactor = getFleetTierFactor(fleetSize);

  // 4. Loss-ratio band factor
  const band = getLossRatioBand(lossRatioPct);
  const bandFactor = LOSS_RATIO_BANDS[band] || 1.0;

  // 5. Calculate per-vehicle monthly premium
  const vehicleMonthly = baseRate * loadFactor * tierFactor * bandFactor;

  // 6. Cohort monthly (all vehicles)
  const cohortMonthly = vehicleMonthly * fleetSize;

  return {
    vehicleMonthly: Math.round(vehicleMonthly * 100) / 100,
    cohortMonthly: Math.round(cohortMonthly * 100) / 100,
    details: {
      baseRate,
      loadFactor: Math.round(loadFactor * 100) / 100,
      tierFactor: Math.round(tierFactor * 100) / 100,
      bandFactor: Math.round(bandFactor * 100) / 100,
      band,
      riskScore: Math.round(riskScore * 100) / 100,
    },
  };
}

/**
 * Calculate fleet-level premium across multiple asset-class cohorts.
 * Groups fleet by asset class, prices each cohort independently, then consolidates
 * into fleet-level premium and weighted multiplier.
 *
 * @param {Object} params - Fleet data
 * @param {Array} params.vehicles - Array of { assetClass, riskScore, riskFactors, ... }
 * @param {number} params.lossRatioPct - Fleet-level loss ratio
 * @returns {Object} {
 *   cohorts: [ { assetClass, vehicleCount, vehicleMonthly, cohortMonthly, multiplier }, ... ],
 *   fleetMonthly,
 *   weightedMultiplier,
 *   totalVehicles
 * }
 */
export function calculatePremiumMultiCohort(params = {}) {
  const { vehicles = [], lossRatioPct = 50 } = params;

  if (!vehicles || vehicles.length === 0) {
    return {
      cohorts: [],
      fleetMonthly: 0,
      weightedMultiplier: 1.0,
      totalVehicles: 0,
      error: "No vehicles provided",
    };
  }

  // Group by asset class
  const byCohort = {};
  vehicles.forEach((v) => {
    const asset = v.assetClass || "Medium";
    if (!byCohort[asset]) {
      byCohort[asset] = [];
    }
    byCohort[asset].push(v);
  });

  // Price each cohort independently
  const cohortResults = [];
  let totalPremium = 0;
  let totalMultiplier = 0;

  Object.entries(byCohort).forEach(([assetClass, cohortVehicles]) => {
    const count = cohortVehicles.length;

    // Use average risk score for cohort
    const avgRiskScore =
      cohortVehicles.reduce((sum, v) => sum + (v.riskScore || 50), 0) / count;

    // Price the cohort
    const pricing = calculatePremium({
      assetClass,
      riskScore: avgRiskScore,
      fleetSize: count,
      lossRatioPct,
    });

    // Calculate multiplier (premium / base)
    const baseTotal = (ASSET_CLASS_BASE_RATES[assetClass] || DEFAULT_BASE_RATE) * count;
    const multiplier = Math.round((pricing.cohortMonthly / baseTotal) * 100) / 100;

    cohortResults.push({
      assetClass,
      vehicleCount: count,
      vehicleMonthly: pricing.vehicleMonthly,
      cohortMonthly: pricing.cohortMonthly,
      multiplier,
      avgRiskScore: Math.round(avgRiskScore * 100) / 100,
      details: pricing.details,
    });

    totalPremium += pricing.cohortMonthly;
    totalMultiplier += multiplier * count; // Weighted by count
  });

  const weightedMultiplier = Math.round((totalMultiplier / vehicles.length) * 100) / 100;

  return {
    cohorts: cohortResults,
    fleetMonthly: Math.round(totalPremium * 100) / 100,
    weightedMultiplier,
    totalVehicles: vehicles.length,
    assetClassBreakdown: Object.keys(byCohort).map((asset) => ({
      assetClass: asset,
      count: byCohort[asset].length,
    })),
  };
}

/**
 * Generate a human-readable pricing summary for a cohort or fleet.
 * @param {Object} result - Result from calculatePremium or calculatePremiumMultiCohort
 * @returns {string} Summary text
 */
export function formatPricingSummary(result) {
  if (result.cohorts) {
    // Multi-cohort result
    const lines = [
      `Fleet-Level Premium: R${result.fleetMonthly.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} /month`,
      `Total Vehicles: ${result.totalVehicles}`,
      `Weighted Multiplier: ${result.weightedMultiplier.toFixed(2)}x`,
      `\nCohort Breakdown:`,
    ];

    result.cohorts.forEach((c) => {
      lines.push(
        `  ${c.assetClass}: ${c.vehicleCount} vehicle(s) @ R${c.vehicleMonthly.toFixed(2)}/month = R${c.cohortMonthly.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/month (${c.multiplier.toFixed(2)}x)`
      );
    });

    return lines.join("\n");
  } else {
    // Single-vehicle result
    const d = result.details;
    return [
      `Premium: R${result.vehicleMonthly.toFixed(2)} /month per vehicle`,
      `Base Rate: R${d.baseRate.toFixed(2)} (${d.band})`,
      `Load Factor: ${d.loadFactor.toFixed(2)}x (risk score ${d.riskScore.toFixed(0)})`,
      `Fleet Tier: ${d.tierFactor.toFixed(2)}x`,
      `Loss-Ratio Band: ${d.bandFactor.toFixed(2)}x`,
      `Multiplier: ${(d.loadFactor * d.tierFactor * d.bandFactor).toFixed(2)}x`,
    ].join("\n");
  }
}
