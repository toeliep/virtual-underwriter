import React, { useState, useCallback, useRef } from "react";
import * as XLSX from "xlsx";
import MultiCohortView from "./MultiCohortView.jsx";
import { generateHcvQuotePDF, generateGitQuotePDF, generateMultiCohortQuotePDF } from "./generateQuotePDF.js";

// ---------------------------------------------------------------------------
// Deterministic scoring engine — JS port of telematix_scoring.py.
// Same rules, same honesty guarantee: never guesses a missing field, never
// silently defaults "no data" to "accept". This is the audit-trail layer;
// the LLM above it only extracts, it never computes a verdict.
// ---------------------------------------------------------------------------

function checkAutoDeclineTriggers(m) {
  const triggers = [];
  if (m.combined_score_used != null && m.combined_score_used > 100) {
    triggers.push("Combined risk score exceeds 100");
  }
  if (m.km_per_vehicle_month != null && m.km_per_vehicle_month > 16000) {
    triggers.push(
      `km/vehicle/month ${Math.round(m.km_per_vehicle_month)} exceeds 16,000 (illegal HoS for single driver)`
    );
  }
  if (m.device_covered_count != null && m.device_covered_count > 200) {
    triggers.push(`Device concealment events ${m.device_covered_count}/mo exceeds 200`);
  }
  if (m.speeding != null && m.fatigue_hos != null && m.speeding > 60 && m.fatigue_hos > 80) {
    triggers.push(`Speeding (${m.speeding}) AND Fatigue (${m.fatigue_hos}) both breach simultaneously`);
  }
  return triggers;
}

function checkRisingTrendReferral(scores, bandLow = 66, bandHigh = 85) {
  const real = scores.filter((s) => s != null);
  if (real.length < 4) return null;
  const last4 = real.slice(-4);
  const strictlyRising = last4.every((v, i) => i === 0 || v > last4[i - 1]);
  const current = last4[last4.length - 1];
  const inAmber = current >= bandLow && current <= bandHigh;
  if (strictlyRising && inAmber) {
    return `4-month rising trend (${last4[0].toFixed(0)} -> ${last4[3].toFixed(0)}) in Amber band, no plateau — refer for underwriting review per trend rule`;
  }
  return null;
}

function scoreFleet(extracted) {
  const fs = extracted.fleet_summary || {};
  let months = (extracted.monthly_data || []).map((m) => ({
    ...m,
    combined_score_used: m.combined_score_reported,
    km_per_vehicle_month: fs.avg_km_per_vehicle_month,
  }));

  if (months.length === 0) {
    months = [
      {
        combined_score_used: fs.combined_risk_score_latest,
        km_per_vehicle_month: fs.avg_km_per_vehicle_month,
      },
    ];
  } else if (months[months.length - 1].combined_score_used == null) {
    months[months.length - 1].combined_score_used = fs.combined_risk_score_latest;
  }

  const monthlyResults = months.map((m) => ({
    ...m,
    triggers: checkAutoDeclineTriggers(m),
  }));

  const latest = monthlyResults[monthlyResults.length - 1];
  const firstBreachIdx = monthlyResults.findIndex((m) => m.triggers.length > 0);

  let verdict, detail;

  if (latest.combined_score_used == null) {
    verdict = "INSUFFICIENT DATA";
    detail = "No usable combined score could be extracted from this document — cannot verify.";
  } else if (firstBreachIdx !== -1) {
    // Toelie-confirmed (9 July 2026): breach anywhere in this document's
    // history -> DECLINE. "OFF COVER" was a dead-code branch that could
    // never actually be reached (firstBreachIdx already caught the latest
    // month's own breach before this point), and the business treats the
    // two labels as meaning the same thing -- consolidated to DECLINE.
    const cleanSince = monthlyResults.slice(firstBreachIdx + 1);
    let cleanStreak = 0;
    for (const m of cleanSince) {
      if (m.triggers.length === 0) cleanStreak += 1;
      else cleanStreak = 0;
    }
    verdict = "DECLINE";
    detail =
      cleanStreak > 0
        ? `Breach on record (month ${firstBreachIdx + 1}); ${cleanStreak} clean month(s) since, but recovery requires 3+ clean months AND documented intervention AND next annual review — conditions not yet confirmed met.`
        : `Breach on record (month ${firstBreachIdx + 1}), fleet has not yet recorded a clean month since.`;
  } else {
    const trend = checkRisingTrendReferral(monthlyResults.map((m) => m.combined_score_used));
    if (trend) {
      verdict = "REFER";
      detail = trend;
    } else {
      verdict = "ACCEPT";
      detail = "No auto-decline trigger fired, no adverse sustained trend detected.";
    }
  }

  return { verdict, detail, latest, monthlyResults, firstBreachIdx };
}

// ---------------------------------------------------------------------------
// GIT scoring engine — JS port of git_scoring.py. Same constants, same
// mandatory-security gate. Hardcoded benchmark scenarios only for now;
// a full input form comes later.
// ---------------------------------------------------------------------------

const GIT_BASE_ANNUAL_RATE = 0.00711;
const GIT_BASE_MONTHLY_RATE = GIT_BASE_ANNUAL_RATE / 12;
const GIT_ALL_RISKS_PERIL_BLEND = 2.0;

const GIT_COMMODITY_FACTORS = {
  coal_mining_bulk: 0.55,
  agricultural_grain: 0.98,
  general_cargo: 1.0,
  building_materials: 1.1,
  timber_paper: 1.15,
  refrigerated_goods: 1.35,
  machinery_equipment: 1.48,
  automotive_parts: 1.65,
  metals_steel_chrome: 2.16,
  pharmaceuticals: 2.5,
  alcohol_beverages: 2.83,
  fuel_petroleum: 2.96,
  electronics_tech: 3.2,
  fmcg_retail_general: 5.0,
  fmcg_branded_high_risk: 8.24,
};

// v2: Commodities appearing in Hollard's GIT General Exclusions (Section F) that TelematiX has
// chosen to make available for referral rather than hard-excluding or auto-pricing. These are
// NOT priced automatically - the correct security tier depends on the specific form/subtype
// being transported (e.g. copper ore & aggregate vs refined copper require different minimum
// locks), which requires case-by-case management research. No commodity factor is assigned.
const GIT_EXCLUDED_COMMODITIES_REQUIRE_REFERRAL = new Set([
  "antiques_artworks",
  "ammunition_explosives_fireworks",
  "bullion_cash_treasury_notes",
  "cameras_cellphones_accessories",
  "prepaid_phone_cards",
  "computers_memory_systems",
  "cobalt",
  "copper_any_form",
  "non_ferrous_metals",
  "gold_silver_jewellery_watches_furs",
  "documents_specie_stamps_tickets",
  "bloodstock_game",
  "tobacco_cigars_cigarettes",
]);

// v2: combined list for the dropdown - priced commodities plus excluded-but-selectable ones
const GIT_ALL_COMMODITY_OPTIONS = [
  ...Object.keys(GIT_COMMODITY_FACTORS),
  ...GIT_EXCLUDED_COMMODITIES_REQUIRE_REFERRAL,
].sort((a, b) => a.localeCompare(b));

const GIT_GEOGRAPHIC_ZONE_LOADING = { western_cape: 1.0, medium_risk: 1.15, gauteng_high_risk: 1.3 };
const GIT_CLAIMS_HISTORY_LOADING = { clean: 1.0, one_claim: 1.15 };
const GIT_FLEET_AGE_LOADING = { new: 1.0, over_10yr: 1.15 };
const GIT_NIGHT_OPS_LOADING = { under_30pct: 1.0, over_30pct: 1.2 };
const GIT_CROSS_BORDER_LOADING = { local: 1.0, sadc: 1.25 };

const GIT_IOT_CREDITS = {
  gps_realtime_tracking: -0.15,
  geofencing_alerting: -0.1,
  driver_behaviour_monitoring: -0.12,
  fatigue_drowsiness_sensor: -0.08,
  cargo_seal_door_sensors: -0.1,
  temperature_humidity_logger: -0.08,
  load_weight_tilt_sensor: -0.1,
  panic_button_armed_response: -0.05,
  dashcam_front_rear: -0.05,
};

const GIT_NO_IOT_PENALTY = 0.2;
const GIT_MAX_IOT_CREDIT = -0.4;
const GIT_PROPOSED_CARGOSNAP_CREDIT = -0.08;
const GIT_PROPOSED_CVTSCPI_RMP_CREDITS = {
  none: 0.0,
  rmp1_top_lock: -0.1,
  rmp2_cable_lock: -0.15,
  rmp3_tracktag: -0.2,
};

// v2: minimum premium floor (Hollard GIT minimum: R5,000 annual per policy)
const GIT_MIN_ANNUAL_PREMIUM = 5000.0;

// v2: regional referral thresholds on load_limit_per_vehicle (Hollard section 4.1 Referrals)
const GIT_REFERRAL_LOAD_LIMIT_WESTERN_CAPE = 1500000; // Cape Town
const GIT_REFERRAL_LOAD_LIMIT_OTHER_ZONES = 1000000; // JHB / KZN (gauteng_high_risk, medium_risk)

// v2: loss ratio referral threshold (Hollard section 4.3 Referrals)
const GIT_LOSS_RATIO_REFERRAL_THRESHOLD_PCT = 65.0;

// v2: restricted cover tiers, expressed as a fraction of the All Risks premium
const GIT_RESTRICTED_COVER_FACTORS = {
  all_risks: 1.0,
  fire_collision_overturning_theft_hijack: 0.8,
  fire_collision_overturning_only: 0.75,
};

// Load-limit-band pricing (Hollard Trucking Underwriting Guide, Section
// 5.1 -- Frans-confirmed 10 July 2026 as the market-standard system,
// replacing the commodity-factor multiplicative formula). Each row is
// [maxLoadLimit, premiumPerVehiclePerMonth]. A declared load limit
// rounds UP to the next available tier (ASSUMPTION, not yet confirmed
// with Frans -- flag if wrong). Above R1,500,000 there is no published
// Hollard rate at all (their own table marks R1.75m/R2m as "Referral")
// -- cannot be auto-priced even with a management override.
const GIT_LOAD_LIMIT_MIN_RAND = 50000;
const GIT_LOAD_LIMIT_MAX_PRICEABLE_RAND = 1500000;
const GIT_LOAD_LIMIT_BAND_PVPM = [
  [50000, 350.0],
  [100000, 450.0],
  [150000, 500.0],
  [200000, 550.0],
  [250000, 650.0],
  [300000, 700.0],
  [350000, 750.0],
  [400000, 800.0],
  [450000, 850.0],
  [500000, 900.0],
  [750000, 1150.0],
  [1000000, 1450.0],
  [1250000, 1700.0],
  [1500000, 1950.0],
];

function gitLoadLimitBandPvpm(loadLimitPerVehicle) {
  if (loadLimitPerVehicle < GIT_LOAD_LIMIT_MIN_RAND) {
    return {
      referral: true,
      reason: `Load limit R${loadLimitPerVehicle.toLocaleString()} is below Hollard's R50,000 minimum priceable band -- refer to management.`,
    };
  }
  for (const [maxLimit, pvpm] of GIT_LOAD_LIMIT_BAND_PVPM) {
    if (loadLimitPerVehicle <= maxLimit) return { pvpm };
  }
  return {
    referral: true,
    reason: `Load limit R${loadLimitPerVehicle.toLocaleString()} exceeds R${GIT_LOAD_LIMIT_MAX_PRICEABLE_RAND.toLocaleString()} -- no published Hollard rate exists above this (their table marks R1.75m/R2m as Referral). Cannot be auto-priced even with an override; management must set a bespoke rate manually.`,
  };
}

function makeGitFleetInput(overrides) {
  return {
    fleet_name: "",
    vehicle_count: 0,
    hcv_truck_count: 0,
    trailer_count: 0,
    hcv_truck_avg_sum_insured: 0,
    trailer_avg_sum_insured: 0,
    load_limit_per_vehicle: 0,
    commodity_type: "general_cargo",
    geographic_zone: "western_cape",
    claims_history: "clean",
    fleet_age: "new",
    night_ops: "under_30pct",
    cross_border: "local",
    vehicle_register: [],
    loss_ratio_pct: null, // v2: actual loss ratio %, if known. null = not yet available.
    fleet_age: "new",
    night_ops: "under_30pct",
    cross_border: "local",
    iot_devices_fitted: [],
    cargosnap_fitted: false,
    cvtscpi_rmp_tier: "none",
    is_high_value_cargo: false,
    is_rmp1_scoped: false,
    cover_type: "all_risks", // v2: "all_risks" | "fire_collision_overturning_theft_hijack" | "fire_collision_overturning_only"
    manual_commodity_factor: null, // v2: only used when overriding an excluded-commodity referral
    ...overrides,
  };
}

// Frans-confirmed (Decision Memo: RMP-1 Mandate for Loads Over R1m).
// Eligibility-gate trigger ONLY -- does not change the rating formula.
// Uses the declared/stated per-vehicle load limit (Q2), strictly per-load,
// no aggregate exposure test (Q3).
const GIT_RMP1_THRESHOLD_RAND = 1_000_000;

function computeGitIotCreditStack(f) {
  if (f.iot_devices_fitted.length === 0 && !f.cargosnap_fitted && f.cvtscpi_rmp_tier === "none") {
    return { total_credit: GIT_NO_IOT_PENALTY, detail: "No IoT devices fitted" };
  }
  let total = 0.0;
  const detail = [];
  for (const device of f.iot_devices_fitted) {
    if (device in GIT_IOT_CREDITS) {
      total += GIT_IOT_CREDITS[device];
      detail.push(`${device}: ${(GIT_IOT_CREDITS[device] * 100).toFixed(0)}%`);
    }
  }
  if (f.cargosnap_fitted) {
    total += GIT_PROPOSED_CARGOSNAP_CREDIT;
    detail.push("cargosnap (proposed): -8%");
  }
  if (f.cvtscpi_rmp_tier !== "none") {
    const credit = GIT_PROPOSED_CVTSCPI_RMP_CREDITS[f.cvtscpi_rmp_tier] ?? 0.0;
    total += credit;
    detail.push(`cvtscpi_${f.cvtscpi_rmp_tier}: ${(credit * 100).toFixed(0)}%`);
  }
  const capped = Math.max(total, GIT_MAX_IOT_CREDIT);
  return { total_credit: capped, uncapped: total, detail, capped: capped !== total };
}

function checkGitMandatorySecurityRequirement(f) {
  const inScope = f.is_high_value_cargo && f.is_rmp1_scoped;
  if (!inScope) {
    return {
      in_scope: false,
      mandatory_met: true,
      note: "Fleet outside high-value/RMP-1 scope - no mandatory requirement applies",
    };
  }
  const tiersOk = new Set(["rmp1_top_lock", "rmp2_cable_lock", "rmp3_tracktag"]);
  const mandatoryMet = tiersOk.has(f.cvtscpi_rmp_tier);
  return {
    in_scope: true,
    mandatory_met: mandatoryMet,
    note: mandatoryMet ? "RMP 1 minimum satisfied" : "COVER CANNOT BIND - CV+TS+CPI RMP 1 (Top Lock) required",
  };
}

// v2: Returns a list of reasons requiring referral to management, or an empty array if none.
// Checks (in order): excluded commodity, regional load-limit threshold, loss ratio.
function checkGitReferralTriggers(f) {
  const reasons = [];

  if (GIT_EXCLUDED_COMMODITIES_REQUIRE_REFERRAL.has(f.commodity_type)) {
    reasons.push(
      `Commodity '${f.commodity_type}' requires a case-by-case security assessment based on transport form/subtype - management approval required before quoting`
    );
  }

  if (f.geographic_zone === "western_cape") {
    if (f.load_limit_per_vehicle > GIT_REFERRAL_LOAD_LIMIT_WESTERN_CAPE) {
      reasons.push(
        `Load limit R${f.load_limit_per_vehicle.toLocaleString()} exceeds Cape Town referral threshold of R${GIT_REFERRAL_LOAD_LIMIT_WESTERN_CAPE.toLocaleString()}`
      );
    }
  } else {
    if (f.load_limit_per_vehicle > GIT_REFERRAL_LOAD_LIMIT_OTHER_ZONES) {
      reasons.push(
        `Load limit R${f.load_limit_per_vehicle.toLocaleString()} exceeds JHB/KZN referral threshold of R${GIT_REFERRAL_LOAD_LIMIT_OTHER_ZONES.toLocaleString()}`
      );
    }
  }

  if (f.loss_ratio_pct != null && f.loss_ratio_pct > GIT_LOSS_RATIO_REFERRAL_THRESHOLD_PCT) {
    reasons.push(
      `Loss ratio ${f.loss_ratio_pct.toFixed(1)}% exceeds referral threshold of ${GIT_LOSS_RATIO_REFERRAL_THRESHOLD_PCT.toFixed(0)}%`
    );
  }

  return reasons;
}

// v2: override is optional {approverName, reason}. If provided, bypasses the REFER checks
// (excluded commodity / regional load limit / loss ratio) and proceeds to premium calculation.
// Does NOT bypass the mandatory CV+TS+CPI RMP1 security requirement, since that reflects
// physical equipment fitted, not a judgment call. Every override is recorded in the result.
function computeGitPvpm(f, override) {
  const referralReasons = checkGitReferralTriggers(f);
  if (referralReasons.length > 0 && !override) {
    return {
      fleet_name: f.fleet_name,
      base_pvpm: null,
      loaded_pvpm: null,
      iot_credit: null,
      final_pvpm: null,
      vehicle_count: f.vehicle_count,
      total_monthly_premium: null,
      annual_premium: null,
      mandatory_security: null,
      referral_reasons: referralReasons,
      override_applied: false,
      verdict: "REFER",
    };
  }

  // Commodity type still gates the referral check above (excluded
  // commodities require management override to proceed at all) but no
  // longer multiplies the price -- pricing is now load-limit-band based
  // (Frans-confirmed 10 July 2026).
  const bandResult = gitLoadLimitBandPvpm(f.load_limit_per_vehicle);
  if (bandResult.referral) {
    if (!override) {
      return {
        fleet_name: f.fleet_name,
        base_pvpm: null,
        loaded_pvpm: null,
        iot_credit: null,
        final_pvpm: null,
        vehicle_count: f.vehicle_count,
        total_monthly_premium: null,
        annual_premium: null,
        mandatory_security: null,
        referral_reasons: [...referralReasons, bandResult.reason],
        override_applied: false,
        verdict: "REFER",
      };
    }
    return { error: bandResult.reason };
  }

  const basePvpm = bandResult.pvpm;
  const geo = GIT_GEOGRAPHIC_ZONE_LOADING[f.geographic_zone] ?? 1.0;
  const claims = GIT_CLAIMS_HISTORY_LOADING[f.claims_history] ?? 1.0;
  const age = GIT_FLEET_AGE_LOADING[f.fleet_age] ?? 1.0;
  const night = GIT_NIGHT_OPS_LOADING[f.night_ops] ?? 1.0;
  const cross = GIT_CROSS_BORDER_LOADING[f.cross_border] ?? 1.0;
  let loadedPvpm = basePvpm * geo * claims * age * night * cross;

  // v2: restricted cover tier applied before IoT credits, matching Hollard/Merx structure
  // (restricted cover is a percentage of the All Risks premium, not stacked with IoT credits)
  const restrictedFactor = GIT_RESTRICTED_COVER_FACTORS[f.cover_type] ?? 1.0;
  loadedPvpm = loadedPvpm * restrictedFactor;

  const iot = computeGitIotCreditStack(f);
  const finalPvpm = loadedPvpm + loadedPvpm * iot.total_credit;
  const security = checkGitMandatorySecurityRequirement(f);
  let totalMonthly = security.mandatory_met ? finalPvpm * f.vehicle_count : null;

  // v2: minimum annual premium floor (R5,000/policy/year, matching Hollard's GIT minimum)
  let annualPremium = null;
  let minPremiumApplied = false;
  if (totalMonthly != null) {
    const annualBeforeFloor = totalMonthly * 12;
    if (annualBeforeFloor < GIT_MIN_ANNUAL_PREMIUM) {
      annualPremium = GIT_MIN_ANNUAL_PREMIUM;
      totalMonthly = GIT_MIN_ANNUAL_PREMIUM / 12;
      minPremiumApplied = true;
    } else {
      annualPremium = annualBeforeFloor;
      minPremiumApplied = false;
    }
  }

  const overrideApplied = Boolean(override && referralReasons.length > 0);

  return {
    fleet_name: f.fleet_name,
    base_pvpm: Math.round(basePvpm * 100) / 100,
    loaded_pvpm: Math.round(loadedPvpm * 100) / 100,
    iot_credit: iot,
    final_pvpm: Math.round(finalPvpm * 100) / 100,
    vehicle_count: f.vehicle_count,
    total_monthly_premium: totalMonthly != null ? Math.round(totalMonthly * 100) / 100 : null,
    annual_premium: annualPremium != null ? Math.round(annualPremium * 100) / 100 : null,
    min_premium_applied: minPremiumApplied,
    cover_type: f.cover_type,
    mandatory_security: security,
    override_applied: overrideApplied,
    override_approver_name: overrideApplied ? override.approverName : null,
    override_reason: overrideApplied ? override.reason : null,
    bypassed_referral_reasons: overrideApplied ? referralReasons : null,
    verdict: security.mandatory_met ? "QUOTABLE" : "CANNOT BIND - mandatory security requirement not met",
  };
}

// ---------------------------------------------------------------------------
// HCV rating/premium engine — JS port of hcv_rating_engine.py, built from
// TelematiX_SA_Rating_Engine_Frans_Prinsloo_3.xlsx (June 2026). Calibrated
// from 1,961 real SA HCV claims (2020-2026), R286m gross exposure.
//
// This is the RATING/PREMIUM layer - it produces an actual R-value premium,
// distinct from scoreFleet() above (HCV risk verdict only, no premium).
//
// Five bugs found and corrected vs the source workbook (confirmed via formula
// inspection, not just displayed values):
//   1-4. Manufacturer/age-band/cargo/corridor VLOOKUP ranges each excluded
//        their own base-case (0%) row by one, causing fleets using the base
//        case to fall back to the wrong default loading instead of 0%.
//   5. Verdict text referenced the wrong cell for the management fee display
//      (always showed R0.000m). Fixed to reference the real calculated fee.
// ---------------------------------------------------------------------------

function hcvExcelRound(value, digits) {
  // Matches Excel's ROUND() (round-half-away-from-zero), avoiding JS's
  // floating-point toFixed() quirks for values like 28.65.
  const factor = Math.pow(10, digits);
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

const HCV_ASSET_CLASS_BASE_RATES = {
  hcv_general_freight: 0.03,
  fuel_hazmat_tanker: 0.022,
  minerals_bulk_long_haul: 0.028,
  fmcg_distribution: 0.03,
  bulk_liquids_non_hazmat: 0.02,
  yellow_metal_plant: 0.02,
  agricultural_equipment: 0.016,
  refrigerated_cold_chain: 0.022,
  abnormal_loads_oversized: 0.03,
  drone_commercial: 0.014,
};

const HCV_TELEMATICS_WEIGHTS = {
  fatigue_hos: 0.20,
  speeding: 0.15,
  cellphone_usage: 0.15,
  safety_belt_compliance: 0.10,
  driver_behaviour_composite: 0.10,
  distance_index: 0.08,
  device_integrity: 0.07,
  time_on_road: 0.03,
  night_driving_ratio: 0.02,
};

const HCV_TREND_MODIFIERS = {
  improving_strongly: -0.15,
  improving_slightly: -0.05,
  stable: 0.0,
  deteriorating_slightly: 0.10,
  deteriorating_3plus_months: 0.20,
};

const HCV_MANUFACTURER_LOADINGS = {
  mercedes_benz: 0.0,
  scania: 0.14,
  volvo: -0.03,
  faw: 0.10,
  man: 0.08,
  daf: 0.08,
  ud_trucks: 0.05,
  freightliner: -0.10,
  western_star: 0.15,
  hino: 0.02,
  isuzu: 0.0,
  other: 0.10,
};
const HCV_MANUFACTURER_LOADING_DEFAULT = 0.10;

const HCV_AGE_BAND_LOADINGS = {
  under_3yr: 0.05,
  "3_to_5yr": 0.12,
  "6_to_8yr": 0.22,
  "9_to_11yr": 0.28,
  "12_to_15yr": 0.15,
  over_15yr: 0.20,
};

function classifyHcvAgeBand(yearModel) {
  if (yearModel >= 2024) return "under_3yr";
  else if (yearModel >= 2021) return "3_to_5yr";
  else if (yearModel >= 2018) return "6_to_8yr";
  else if (yearModel >= 2016) return "9_to_11yr";
  else if (yearModel >= 2013) return "12_to_15yr";
  else return "over_15yr";
}

const HCV_CARGO_LOADINGS = {
  general_merchandise: 0.0,
  fuel_petroleum: 0.35,
  minerals_mining: 0.40,
  fmcg_food_bev: 0.15,
  refrigerated: 0.20,
  steel_metals: 0.18,
  chemicals_non_hazmat: 0.25,
  chemicals_hazmat_adr: 0.55,
  electronics_high_value: 0.45,
  agricultural_produce: 0.12,
  retail_clothing: 0.10,
  livestock: 0.30,
};
const HCV_CARGO_LOADING_DEFAULT = 0.10;

const HCV_CORRIDOR_LOADINGS = {
  mixed_sa_national: 0.0,
  n1_cape_johannesburg: 0.12,
  n3_johannesburg_durban: 0.18,
  n12_east_rand_port_elizabeth: 0.15,
  n14_n4_botswana_border: 0.20,
  n1_north_limpopo_zimbabwe_border: 0.22,
  western_cape_regional: 0.08,
  kwazulu_natal_regional: 0.10,
  northern_cape_manganese_routes: 0.35,
  cross_border_sadc: 0.30,
};
const HCV_CORRIDOR_LOADING_DEFAULT = 0.10;

const HCV_ANTI_THEFT_CREDITS = {
  none: 0.0,
  tracking_only: -0.06,
  tracking_and_immobiliser: -0.12,
};

const HCV_MANAGEMENT_FEE_RATE = 0.11;

// Fleet-size base-rate multiplier (Lombard reference slide, Frans-confirmed
// 9 July 2026). MULTIPLIES the existing asset-class base rate -- does not
// replace it. Extrapolates the X-Large rate indefinitely above 100 vehicles.
// Medium chosen as the 1.0x baseline.
const HCV_FLEET_SIZE_BASELINE_RATE = 0.0525;
const HCV_FLEET_SIZE_TIERS = [
  { label: "Small", minVehicles: 1, maxVehicles: 5, targetRate: 0.06 },
  { label: "Medium", minVehicles: 6, maxVehicles: 20, targetRate: 0.0525 },
  { label: "Large", minVehicles: 21, maxVehicles: 50, targetRate: 0.0475 },
  { label: "X-Large", minVehicles: 51, maxVehicles: Infinity, targetRate: 0.04 },
];
function hcvFleetSizeMultiplier(vehicleCount) {
  const tier =
    HCV_FLEET_SIZE_TIERS.find((t) => vehicleCount >= t.minVehicles && vehicleCount <= t.maxVehicles) ||
    HCV_FLEET_SIZE_TIERS[HCV_FLEET_SIZE_TIERS.length - 1];
  return hcvExcelRound(tier.targetRate / HCV_FLEET_SIZE_BASELINE_RATE, 6);
}

// Claims-experience loading (Lombard reference slide, Frans-confirmed).
// ADDITIVE to the existing market loading stack. No claims history
// defaults to the highest band (30%), same conservative-default
// principle as the no-telemetry fallback.
const HCV_CLAIMS_EXPERIENCE_NO_HISTORY_LOADING = 0.00; // Frans-confirmed 9 July 2026: opt-in only -- no penalty unless a real loss ratio is entered
const HCV_CLAIMS_EXPERIENCE_BANDS = [
  { minLossRatioPct: 0, maxLossRatioPct: 60, loading: 0.05 },
  { minLossRatioPct: 61, maxLossRatioPct: 70, loading: 0.10 },
  { minLossRatioPct: 71, maxLossRatioPct: 85, loading: 0.20 },
  { minLossRatioPct: 86, maxLossRatioPct: 90, loading: 0.25 },
  { minLossRatioPct: 91, maxLossRatioPct: Infinity, loading: 0.30 },
];
function hcvClaimsExperienceLoading(lossRatioPct) {
  if (lossRatioPct == null) return HCV_CLAIMS_EXPERIENCE_NO_HISTORY_LOADING;
  const band =
    HCV_CLAIMS_EXPERIENCE_BANDS.find((b) => lossRatioPct >= b.minLossRatioPct && lossRatioPct <= b.maxLossRatioPct) ||
    HCV_CLAIMS_EXPERIENCE_BANDS[HCV_CLAIMS_EXPERIENCE_BANDS.length - 1];
  return band.loading;
}

// Static risk questionnaire (Lombard reference slide + Frans-confirmed
// scope). 7 items, each 0/35/70/100, averaged into a 10% weighted factor
// matching the pitch deck's 10-factor model. avg km/month, cargo type,
// and Route Risk Level deliberately excluded -- already priced elsewhere.
// 4-tier scoring rubric drafted 25 Jul 2026, provisionally approved by
// Frans -- see HCV_STATIC_QUESTIONNAIRE_RUBRIC below.
const HCV_STATIC_QUESTIONNAIRE_ITEMS = [
  "driving_hour_policy",
  "max_speed_policy",
  "telematics_use_for_driver_management",
  "route_distance",
  "driver_training_programme",
  "driver_employment_process",
  "driver_remuneration",
];
function hcvComputeStaticRiskScore(f) {
  const values = HCV_STATIC_QUESTIONNAIRE_ITEMS.map((k) => f[k]);
  if (values.some((v) => v == null)) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  return hcvExcelRound(sum / HCV_STATIC_QUESTIONNAIRE_ITEMS.length, 1);
}

// 4-tier scoring rubric (0 / 35 / 70 / 100) per item -- drafted for Frans
// 25 Jul 2026, provisionally approved ("looks right", detailed review to
// follow). Replaces free-text 0-100 entry with a fixed rubric so different
// brokers scoring the same fleet converge on the same number.
const HCV_STATIC_QUESTIONNAIRE_RUBRIC = {
  driving_hour_policy: {
    0: "No written driving-hour policy exists. No maximum shift length defined.",
    35: "Written policy exists but compliance tracked manually (paper logbooks), no regular audit.",
    70: "Written policy with defined shift limits. Compliance monitored via electronic logbooks or telematics alerts.",
    100: "Policy enforced via real-time telematics monitoring with automated fatigue/shift-limit alerts. Regular audits, documented disciplinary process.",
  },
  max_speed_policy: {
    0: "No speed policy exists. No speed limiters or GPS-based speed monitoring.",
    35: "Speed policy exists on paper. Factory speed limiters only, no active monitoring.",
    70: "Written speed policy with defined limits. GPS/telematics monitoring with regular management review. Repeat offenders formally warned.",
    100: "Speed policy enforced via real-time telematics alerts. Automated exception reports, escalation triggers, documented disciplinary outcomes.",
  },
  telematics_use_for_driver_management: {
    0: "No telematics platform, or data not used for any management purpose.",
    35: "Telematics installed and collected, but only reviewed reactively after incidents.",
    70: "Telematics data reviewed regularly (weekly/monthly). Driver scorecards produced and shared with drivers.",
    100: "Telematics is the backbone of driver management: real-time dashboards, automated scorecards, feeds training/bonus/disciplinary processes.",
  },
  route_distance: {
    0: "No route planning or distance management. Drivers choose their own routes.",
    35: "Basic route planning (preferred corridors communicated verbally). No electronic route compliance monitoring.",
    70: "Routes planned and assigned electronically. GPS tracking confirms compliance with deviation alerts.",
    100: "Dynamic route planning integrated with telematics. Real-time deviation alerts, geofenced rest stops, route efficiency analytics.",
  },
  driver_training_programme: {
    0: "No formal training programme. Drivers hired on licence and experience only.",
    35: "Basic induction on hire, no scheduled refresher training, no defensive driving.",
    70: "Formal induction covering vehicle operation, cargo handling, safety. Annual refresher and defensive driving course completed.",
    100: "Comprehensive induction + annual refreshers + advanced defensive driving certification + cargo-specific training, driven by telematics/incident data.",
  },
  driver_employment_process: {
    0: "No structured hiring process. Licence check only.",
    35: "Basic hiring: licence validity, one reference check. No criminal record check, no medical fitness assessment.",
    70: "Structured process: licence verification, criminal record check, 2+ references, medical fitness assessment, defined probation period.",
    100: "Comprehensive process: all of the above plus psychometric evaluation, telematics-based probation review, periodic re-screening.",
  },
  driver_remuneration: {
    0: "Drivers paid purely per trip/km. No fixed component. Incentivises speed and distance over safety.",
    35: "Fixed salary below market, supplemented by per-trip bonuses with no safety/compliance component.",
    70: "Market-competitive fixed salary. Bonus includes a safety/compliance component.",
    100: "Competitive fixed salary with bonus directly linked to telematics scorecard performance. Penalty mechanisms for repeat violations.",
  },
};
const HCV_STATIC_QUESTIONNAIRE_TIER_LABELS = { 0: "0 — None", 35: "35 — Basic", 70: "70 — Good", 100: "100 — Best practice" };

// Frans-confirmed (Decision Memo: No-Telemetry Fallback Methodology, Q1):
// top of the Medium band (31-65), not the workbook's own mixed-band sample
// defaults, which compute to a near-cheapest rating factor and are NOT a
// conservative "no data" fallback.
const HCV_NO_TELEMETRY_DEFAULT_SCORE = 65;

const HCV_AUTO_DECLINE_KM_PER_MONTH_THRESHOLD = 16000;
const HCV_AUTO_DECLINE_CONCEALMENT_THRESHOLD = 200;
const HCV_AUTO_DECLINE_SPEEDING_THRESHOLD = 60;
const HCV_AUTO_DECLINE_FATIGUE_THRESHOLD = 80;

function makeHcvFleetInput(overrides) {
  return {
    fleet_name: "",
    asset_class: "hcv_general_freight",
    vehicle_count: 0,
    avg_sum_insured_per_vehicle: 0,
    manufacturer: "mercedes_benz",
    year_model: new Date().getFullYear(),
    avg_km_per_vehicle_month: 0,
    // Frans-confirmed (Decision Memo: HCV Data-Source Qualifier, Aug 2026).
    // Three-option selector replaces the old binary telemetry_available toggle.
    hcv_data_source: "none",
    fatigue_hos: 0,
    speeding: 0,
    cellphone_usage: 0,
    safety_belt_compliance: 0,
    driver_behaviour_composite: 0,
    distance_index: 0,
    device_integrity: 0,
    time_on_road: 0,
    night_driving_ratio: 0,
    trend_direction: "stable",
    device_concealment_events_per_month: 0,
    static_questionnaire_complete: true,
    cargo_type: "general_merchandise",
    operating_corridor: "mixed_sa_national",
    night_ops_pct: 0.0,
    anti_theft_devices: "none",
    // NEW: claims experience + static risk questionnaire (Frans-confirmed,
    // Lombard reference slide). loss_ratio_pct null = no claims history
    // (defaults to worst band, 30%). Static items null = falls back to
    // the existing flat +10 questionnaire-completeness penalty.
    loss_ratio_pct: null,
    driving_hour_policy: null,
    max_speed_policy: null,
    telematics_use_for_driver_management: null,
    route_distance: null,
    driver_training_programme: null,
    driver_employment_process: null,
    driver_remuneration: null,
    ...overrides,
  };
}

function computeHcvWeightedTelematicsScore(f) {
  let total = 0.0;
  for (const factor of Object.keys(HCV_TELEMATICS_WEIGHTS)) {
    total += f[factor] * HCV_TELEMATICS_WEIGHTS[factor];
  }
  // NEW: static risk questionnaire, 10% weight, only when all 7 items are
  // supplied -- Frans-confirmed scope (Lombard reference slide).
  const staticRiskScore = hcvComputeStaticRiskScore(f);
  if (staticRiskScore != null) total += staticRiskScore * 0.10;
  return hcvExcelRound(total, 1);
}

function computeHcvCombinedTelematicsScore(f, weightedScore) {
  let concealmentAddition = 0;
  if (f.device_concealment_events_per_month > 200) concealmentAddition = 30;
  else if (f.device_concealment_events_per_month > 100) concealmentAddition = 15;

  // NEW: skip the flat penalty when the richer static questionnaire
  // score is being used -- it already reflects completeness/quality.
  const usingNewStaticScoreForPenalty = hcvComputeStaticRiskScore(f) != null;
  const questionnairePenalty = usingNewStaticScoreForPenalty ? 0 : (!f.static_questionnaire_complete ? 10 : 0);
  const trendModifier = HCV_TREND_MODIFIERS[f.trend_direction] ?? 0.0;
  const trendAddition = weightedScore * trendModifier;

  const combined = weightedScore + concealmentAddition + questionnairePenalty + trendAddition;
  return hcvExcelRound(combined, 0);
}

function checkHcvAutoDecline(f, combinedScore) {
  const triggers = [];
  if (combinedScore > 100) {
    triggers.push(`Combined telematics score ${combinedScore.toFixed(0)} exceeds 100`);
  }
  if (f.avg_km_per_vehicle_month > HCV_AUTO_DECLINE_KM_PER_MONTH_THRESHOLD) {
    triggers.push(
      `Avg km/vehicle/month ${f.avg_km_per_vehicle_month.toLocaleString()} exceeds ${HCV_AUTO_DECLINE_KM_PER_MONTH_THRESHOLD.toLocaleString()} (illegal HoS for single driver)`
    );
  }
  if (f.device_concealment_events_per_month > HCV_AUTO_DECLINE_CONCEALMENT_THRESHOLD) {
    triggers.push(
      `Device concealment events ${f.device_concealment_events_per_month}/mo exceeds ${HCV_AUTO_DECLINE_CONCEALMENT_THRESHOLD}`
    );
  }
  if (f.speeding > HCV_AUTO_DECLINE_SPEEDING_THRESHOLD && f.fatigue_hos > HCV_AUTO_DECLINE_FATIGUE_THRESHOLD) {
    triggers.push(`Speeding (${f.speeding}) AND Fatigue (${f.fatigue_hos}) both breach simultaneously`);
  }
  return triggers;
}

function hcvTelematicsRatingFactor(combinedScore) {
  if (combinedScore > 100) return null;
  else if (combinedScore <= 25) return 0.70;
  else if (combinedScore <= 45) return 0.95;
  else if (combinedScore <= 65) return 1.40;
  else if (combinedScore <= 85) return 1.90;
  else return 2.50;
}

function computeHcvPremium(f) {
  const weightedScore = computeHcvWeightedTelematicsScore(f);
  const staticRiskScoreForOutput = hcvComputeStaticRiskScore(f);
  const combinedScore = computeHcvCombinedTelematicsScore(f, weightedScore);

  const autoDeclineReasons = checkHcvAutoDecline(f, combinedScore);
  if (autoDeclineReasons.length > 0) {
    return {
      fleet_name: f.fleet_name,
      weighted_telematics_score: weightedScore,
      combined_telematics_score: combinedScore,
      rating_factor: null,
      total_sa_market_loading: null,
      combined_rating_factor: null,
      total_fleet_sum_insured: f.vehicle_count * f.avg_sum_insured_per_vehicle,
      market_rate_base_premium: null,
      risk_adjusted_premium: null,
      premium_saving_vs_market: null,
      additional_premium_vs_market: null,
      management_fee: null,
      auto_decline_reasons: autoDeclineReasons,
      verdict: "DECLINE - Auto-decline triggered. Do not quote.",
    };
  }

  const ratingFactor = hcvTelematicsRatingFactor(combinedScore);

  const manufacturerLoading = HCV_MANUFACTURER_LOADINGS[f.manufacturer] ?? HCV_MANUFACTURER_LOADING_DEFAULT;
  const ageBand = classifyHcvAgeBand(f.year_model);
  const ageBandLoading = HCV_AGE_BAND_LOADINGS[ageBand] ?? 0.20;
  const cargoLoading = HCV_CARGO_LOADINGS[f.cargo_type] ?? HCV_CARGO_LOADING_DEFAULT;
  const corridorLoading = HCV_CORRIDOR_LOADINGS[f.operating_corridor] ?? HCV_CORRIDOR_LOADING_DEFAULT;
  const antiTheftCredit = HCV_ANTI_THEFT_CREDITS[f.anti_theft_devices] ?? 0.0;
  const nightOpsLoading = f.night_ops_pct > 0.20 ? 0.10 : f.night_ops_pct > 0.10 ? 0.05 : 0.0;

  const claimsExperienceLoading = hcvClaimsExperienceLoading(f.loss_ratio_pct);
  const totalSaMarketLoading = hcvExcelRound(
    manufacturerLoading + ageBandLoading + cargoLoading + corridorLoading + antiTheftCredit + nightOpsLoading + claimsExperienceLoading,
    4
  );
  const combinedRatingFactor = hcvExcelRound(ratingFactor * (1 + totalSaMarketLoading), 4);

  const assetClassBaseRate = HCV_ASSET_CLASS_BASE_RATES[f.asset_class];
  if (assetClassBaseRate == null) {
    return { error: `Unknown asset_class: ${f.asset_class}` };
  }
  const fleetSizeMultiplier = hcvFleetSizeMultiplier(f.vehicle_count);
  const baseRate = hcvExcelRound(assetClassBaseRate * fleetSizeMultiplier, 8);

  const totalFleetSumInsured = f.vehicle_count * f.avg_sum_insured_per_vehicle;
  const marketRateBasePremium = totalFleetSumInsured * baseRate;
  const riskAdjustedPremium = totalFleetSumInsured * baseRate * combinedRatingFactor;

  const premiumSavingVsMarket = Math.max(0.0, marketRateBasePremium - riskAdjustedPremium);
  const additionalPremiumVsMarket = Math.max(0.0, riskAdjustedPremium - marketRateBasePremium);
  const managementFee = riskAdjustedPremium * HCV_MANAGEMENT_FEE_RATE;

  let verdict, profile;
  if (combinedScore <= 45) {
    verdict = `ACCEPT - Profile A. Score: ${combinedScore.toFixed(0)} | Factor: ${combinedRatingFactor.toFixed(2)}x | Premium: R${riskAdjustedPremium.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | Fee: R${managementFee.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}. Conditions: monthly data sharing, annual questionnaire.`;
    profile = "A";
  } else if (combinedScore <= 85) {
    verdict = `CONDITIONAL ACCEPT - Profile B. Score: ${combinedScore.toFixed(0)} | Factor: ${combinedRatingFactor.toFixed(2)}x | Premium: R${riskAdjustedPremium.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}. Mandatory: HoS plan, cellphone warranty, speed limiter verification, 30-day cancellation right.`;
    profile = "B";
  } else {
    verdict = `DECLINE - Score ${combinedScore.toFixed(0)} exceeds 85. Profile C threshold. Do not quote.`;
    profile = "C";
  }

  // Frans-confirmed (Decision Memo: HCV Data-Source Qualifier, Aug 2026):
  // Only Fleetboard + video reaches full 96.2% coverage → Profile A eligible.
  // OEM-only (61.2% — cellphone + belt are blind spots) and no-telematics both
  // cap at Profile B regardless of computed score.
  if (profile === "A" && f.hcv_data_source !== "oem_video") {
    profile = "B";
    const capReason = f.hcv_data_source === "oem_only"
      ? "OEM telematics only (61.2% coverage — cellphone & belt data unavailable without driver-facing camera)"
      : "no real telematics data — estimated scores only";
    verdict = `CONDITIONAL ACCEPT - Profile B (capped from Profile A: ${capReason}, per underwriting policy). Score: ${combinedScore.toFixed(0)} | Factor: ${combinedRatingFactor.toFixed(2)}x | Premium: R${riskAdjustedPremium.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}. Mandatory: HoS plan, cellphone warranty, speed limiter verification, 30-day cancellation right.`;
  }

  return {
    fleet_name: f.fleet_name,
    weighted_telematics_score: weightedScore,
    combined_telematics_score: combinedScore,
    rating_factor: ratingFactor,
    manufacturer_loading: manufacturerLoading,
    age_band: ageBand,
    age_band_loading: ageBandLoading,
    cargo_loading: cargoLoading,
    corridor_loading: corridorLoading,
    anti_theft_credit: antiTheftCredit,
    night_ops_loading: nightOpsLoading,
    claims_experience_loading: claimsExperienceLoading,
    total_sa_market_loading: totalSaMarketLoading,
    combined_rating_factor: combinedRatingFactor,
    asset_class_base_rate: assetClassBaseRate,
    fleet_size_multiplier: fleetSizeMultiplier,
    static_risk_score: staticRiskScoreForOutput,
    total_fleet_sum_insured: hcvExcelRound(totalFleetSumInsured, 2),
    market_rate_base_premium: hcvExcelRound(marketRateBasePremium, 2),
    risk_adjusted_premium: hcvExcelRound(riskAdjustedPremium, 2),
    premium_saving_vs_market: hcvExcelRound(premiumSavingVsMarket, 2),
    additional_premium_vs_market: hcvExcelRound(additionalPremiumVsMarket, 2),
    management_fee: hcvExcelRound(managementFee, 2),
    profile,
    verdict,
  };
}

function HcvRatingView({ sharedFleetInfo }) {
  const [form, setForm] = useState(() =>
    makeHcvFleetInput(
      sharedFleetInfo
        ? {
            fleet_name: sharedFleetInfo.fleet_name,
            vehicle_count: sharedFleetInfo.vehicle_count,
            asset_class: sharedFleetInfo.asset_class,
            avg_sum_insured_per_vehicle: sharedFleetInfo.avg_sum_insured_per_vehicle,
            manufacturer: sharedFleetInfo.manufacturer,
            year_model: sharedFleetInfo.year_model,
            avg_km_per_vehicle_month: sharedFleetInfo.avg_km_per_vehicle_month,
            cargo_type: sharedFleetInfo.cargo_type,
            operating_corridor: sharedFleetInfo.operating_corridor,
            night_ops_pct: sharedFleetInfo.night_ops_pct,
            anti_theft_devices: sharedFleetInfo.anti_theft_devices,
            trend_direction: sharedFleetInfo.trend_direction,
            device_concealment_events_per_month: sharedFleetInfo.device_concealment_events_per_month,
            static_questionnaire_complete: sharedFleetInfo.static_questionnaire_complete,
            loss_ratio_pct: sharedFleetInfo.loss_ratio_pct,
          }
        : {}
    )
  );
  const [result, setResult] = useState(null);

  const updateField = (key, value) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const computeQuote = () => {
    setResult(computeHcvPremium(form));
  };

  return (
    <div>
      <div
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: "0.75rem",
          color: "#B5762A",
          marginBottom: "16px",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        HCV Rating
      </div>

      <div style={{ marginBottom: "20px" }}>
        <SectionLabel>Fleet &amp; vehicle details</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "12px", marginTop: "12px" }}>
          <FormField label="Fleet name">
            <input
              type="text"
              value={form.fleet_name}
              onChange={(e) => updateField("fleet_name", e.target.value)}
              style={formInputStyle}
            />
          </FormField>
          <FormField label="Asset class">
            <select
              value={form.asset_class}
              onChange={(e) => updateField("asset_class", e.target.value)}
              style={formInputStyle}
            >
              {Object.keys(HCV_ASSET_CLASS_BASE_RATES)
                .sort((a, b) => a.localeCompare(b))
                .map((key) => (
                  <option key={key} value={key}>
                    {key.replace(/_/g, " ")}
                  </option>
                ))}
            </select>
          </FormField>
          <FormField label="Number of vehicles">
            <input
              onFocus={(e) => setTimeout(() => e.target.select(), 0)}
              type="number"
              value={form.vehicle_count}
              onChange={(e) => updateField("vehicle_count", Number(e.target.value))}
              onWheel={(e) => e.target.blur()}
              style={formInputStyle}
            />
          </FormField>
          <FormField label="Avg sum insured per vehicle (R)">
            <input
              onFocus={(e) => setTimeout(() => e.target.select(), 0)}
              type="number"
              value={form.avg_sum_insured_per_vehicle}
              onChange={(e) => updateField("avg_sum_insured_per_vehicle", Number(e.target.value))}
              onWheel={(e) => e.target.blur()}
              step="50000"
              style={formInputStyle}
            />
          </FormField>
          <FormField label="Manufacturer">
            <select
              value={form.manufacturer}
              onChange={(e) => updateField("manufacturer", e.target.value)}
              style={formInputStyle}
            >
              {Object.keys(HCV_MANUFACTURER_LOADINGS)
                .sort((a, b) => a.localeCompare(b))
                .map((key) => (
                  <option key={key} value={key}>
                    {key.replace(/_/g, " ")}
                  </option>
                ))}
            </select>
          </FormField>
          <FormField label="Average vehicle year model">
            <input
              onFocus={(e) => setTimeout(() => e.target.select(), 0)}
              type="number"
              value={form.year_model}
              onChange={(e) => updateField("year_model", Number(e.target.value))}
              onWheel={(e) => e.target.blur()}
              style={formInputStyle}
            />
          </FormField>
          <FormField label="Avg km / vehicle / month">
            <input
              onFocus={(e) => setTimeout(() => e.target.select(), 0)}
              type="number"
              value={form.avg_km_per_vehicle_month}
              onChange={(e) => updateField("avg_km_per_vehicle_month", Number(e.target.value))}
              onWheel={(e) => e.target.blur()}
              style={formInputStyle}
            />
          </FormField>
        </div>
      </div>

      <div style={{ marginBottom: "20px" }}>
        <SectionLabel>Telematics behavioural scores (0–100, approved platform)</SectionLabel>

        {/* HCV data-source qualifier — Frans-confirmed Aug 2026; replaces binary telemetry_available */}
        <div style={{ marginTop: "10px", marginBottom: "6px", fontSize: "0.78rem", color: "#5C6570" }}>
          HCV telematics data source
        </div>
        <select
          value={form.hcv_data_source || "none"}
          style={{ ...formInputStyle, marginBottom: "8px" }}
          onChange={(e) => {
            const ds = e.target.value;
            setForm((f) => {
              if (ds === "oem_video") return { ...f, hcv_data_source: ds };
              if (ds === "oem_only") {
                // Cellphone (15%) and belt (10%) are blind without camera — default those.
                return { ...f, hcv_data_source: ds, cellphone_usage: HCV_NO_TELEMETRY_DEFAULT_SCORE, safety_belt_compliance: HCV_NO_TELEMETRY_DEFAULT_SCORE };
              }
              // No telematics — default all scored fields to top-of-Medium.
              return {
                ...f,
                hcv_data_source: ds,
                fatigue_hos: HCV_NO_TELEMETRY_DEFAULT_SCORE,
                speeding: HCV_NO_TELEMETRY_DEFAULT_SCORE,
                cellphone_usage: HCV_NO_TELEMETRY_DEFAULT_SCORE,
                safety_belt_compliance: HCV_NO_TELEMETRY_DEFAULT_SCORE,
                driver_behaviour_composite: HCV_NO_TELEMETRY_DEFAULT_SCORE,
                distance_index: HCV_NO_TELEMETRY_DEFAULT_SCORE,
                device_integrity: HCV_NO_TELEMETRY_DEFAULT_SCORE,
                time_on_road: HCV_NO_TELEMETRY_DEFAULT_SCORE,
                night_driving_ratio: HCV_NO_TELEMETRY_DEFAULT_SCORE,
              };
            });
          }}
        >
          <option value="none">No telematics — Profile B cap, mandatory conditions (1.40×)</option>
          <option value="oem_only">Fleetboard / OEM only — 61.2% coverage, Profile B cap (1.40×)</option>
          <option value="oem_video">Fleetboard + driver-facing video — 96.2% coverage, Profile A eligible (0.70×)</option>
        </select>
        {(form.hcv_data_source === "none" || !form.hcv_data_source) && (
          <div style={{ fontSize: "0.78rem", color: "#B5762A", marginBottom: "10px", lineHeight: 1.5 }}>
            No telematics — all scores defaulted to {HCV_NO_TELEMETRY_DEFAULT_SCORE} (top of Medium band). Fleet capped at Profile B regardless of computed score.
          </div>
        )}
        {form.hcv_data_source === "oem_only" && (
          <div style={{ fontSize: "0.78rem", color: "#B5762A", marginBottom: "10px", lineHeight: 1.5 }}>
            OEM only — cellphone usage and safety-belt compliance defaulted to {HCV_NO_TELEMETRY_DEFAULT_SCORE} (data gap: no camera). Fleet capped at Profile B.
          </div>
        )}
        {form.hcv_data_source === "oem_video" && (
          <div style={{ fontSize: "0.78rem", color: "#2E6B3E", marginBottom: "10px", lineHeight: 1.5 }}>
            Full coverage — 96.2% visibility. Profile A eligible. All 10 metrics can be entered.
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "12px", marginTop: "12px" }}>
          {[
            ["fatigue_hos", "Fatigue / Hours of Service"],
            ["speeding", "Speeding"],
            ["cellphone_usage", "Cellphone usage (talk + text)"],
            ["safety_belt_compliance", "Safety belt compliance"],
            ["driver_behaviour_composite", "Driver behaviour composite"],
            ["distance_index", "Distance index"],
            ["device_integrity", "Device integrity"],
            ["time_on_road", "Time on road"],
            ["night_driving_ratio", "Night driving ratio"],
          ].map(([key, label]) => (
            <FormField key={key} label={label}>
              <input
              onFocus={(e) => setTimeout(() => e.target.select(), 0)}
                type="number"
                min="0"
                max="100"
                value={form[key]}
                disabled={
                  form.hcv_data_source === "none" ||
                  (form.hcv_data_source === "oem_only" && (key === "cellphone_usage" || key === "safety_belt_compliance"))
                }
                onChange={(e) => updateField(key, Number(e.target.value))}
                onWheel={(e) => e.target.blur()}
                style={{
                  ...formInputStyle,
                  opacity: (form.hcv_data_source === "none" || (form.hcv_data_source === "oem_only" && (key === "cellphone_usage" || key === "safety_belt_compliance"))) ? 0.5 : 1,
                }}
              />
            </FormField>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: "20px" }}>
        <SectionLabel>Telematics score modifiers</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "12px", marginTop: "12px" }}>
          <FormField label="Trend direction (3-month rolling)">
            <select
              value={form.trend_direction}
              onChange={(e) => updateField("trend_direction", e.target.value)}
              style={formInputStyle}
            >
              <option value="improving_strongly">Improving strongly (-15%)</option>
              <option value="improving_slightly">Improving slightly (-5%)</option>
              <option value="stable">Stable (0%)</option>
              <option value="deteriorating_slightly">Deteriorating slightly (+10%)</option>
              <option value="deteriorating_3plus_months">Deteriorating - 3+ months (+20%)</option>
            </select>
          </FormField>
          <FormField label="Device concealment events/month">
            <input
              onFocus={(e) => setTimeout(() => e.target.select(), 0)}
              type="number"
              value={form.device_concealment_events_per_month}
              onChange={(e) => updateField("device_concealment_events_per_month", Number(e.target.value))}
              onWheel={(e) => e.target.blur()}
              style={formInputStyle}
            />
          </FormField>
          <FormField label="Static questionnaire complete?">
            <select
              value={form.static_questionnaire_complete ? "yes" : "no"}
              onChange={(e) => updateField("static_questionnaire_complete", e.target.value === "yes")}
              style={formInputStyle}
            >
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </FormField>
          <FormField label="Loss ratio % (blank = 0% loading, opt-in only)">
            <input
              onFocus={(e) => setTimeout(() => e.target.select(), 0)}
              type="number"
              min="0"
              value={form.loss_ratio_pct ?? ""}
              onChange={(e) => updateField("loss_ratio_pct", e.target.value === "" ? null : Number(e.target.value))}
              onWheel={(e) => e.target.blur()}
              style={formInputStyle}
            />
          </FormField>
        </div>
      </div>

      <div style={{ marginBottom: "20px" }}>
        <SectionLabel>Static risk questionnaire (optional -- 7 items, 4-tier rubric)</SectionLabel>
        <div style={{ fontSize: "0.78rem", color: "#B5762A", marginTop: "8px", marginBottom: "10px", lineHeight: 1.5 }}>
          Leave on "Not scored" to use the Yes/No completeness check above instead. Score all 7 to use the
          richer 10%-weighted score. Rubric drafted for and provisionally approved by Frans (25 Jul 2026) --
          each tier defined by a concrete, checkable criterion so different brokers converge on the same score.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "12px", marginTop: "12px" }}>
          {[
            ["driving_hour_policy", "Driving hour policy"],
            ["max_speed_policy", "Max speed policy"],
            ["telematics_use_for_driver_management", "Telematics use for driver mgmt"],
            ["route_distance", "Route distance"],
            ["driver_training_programme", "Driver training programme"],
            ["driver_employment_process", "Driver employment process"],
            ["driver_remuneration", "Driver remuneration"],
          ].map(([key, label]) => (
            <FormField key={key} label={label}>
              <select
                value={form[key] ?? ""}
                onChange={(e) => updateField(key, e.target.value === "" ? null : Number(e.target.value))}
                style={formInputStyle}
              >
                <option value="">Not scored</option>
                {[0, 35, 70, 100].map((tier) => (
                  <option key={tier} value={tier}>
                    {HCV_STATIC_QUESTIONNAIRE_TIER_LABELS[tier]}
                  </option>
                ))}
              </select>
              {form[key] != null && (
                <div style={{ fontSize: "0.74rem", color: "#5C6570", marginTop: "6px", lineHeight: 1.4 }}>
                  {HCV_STATIC_QUESTIONNAIRE_RUBRIC[key][form[key]]}
                </div>
              )}
            </FormField>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: "24px" }}>
        <SectionLabel>SA market peril &amp; event profile</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "12px", marginTop: "12px" }}>
          <FormField label="Primary cargo type">
            <select
              value={form.cargo_type}
              onChange={(e) => updateField("cargo_type", e.target.value)}
              style={formInputStyle}
            >
              {Object.keys(HCV_CARGO_LOADINGS)
                .sort((a, b) => a.localeCompare(b))
                .map((key) => (
                  <option key={key} value={key}>
                    {key.replace(/_/g, " ")}
                  </option>
                ))}
            </select>
          </FormField>
          <FormField label="Primary operating corridor">
            <select
              value={form.operating_corridor}
              onChange={(e) => updateField("operating_corridor", e.target.value)}
              style={formInputStyle}
            >
              {Object.keys(HCV_CORRIDOR_LOADINGS)
                .sort((a, b) => a.localeCompare(b))
                .map((key) => (
                  <option key={key} value={key}>
                    {key.replace(/_/g, " ")}
                  </option>
                ))}
            </select>
          </FormField>
          <FormField label="Night operations (% distance after 22:00)">
            <input
              onFocus={(e) => setTimeout(() => e.target.select(), 0)}
              type="number"
              min="0"
              max="100"
              value={Math.round(form.night_ops_pct * 100)}
              onChange={(e) => updateField("night_ops_pct", Number(e.target.value) / 100)}
              onWheel={(e) => e.target.blur()}
              style={formInputStyle}
            />
          </FormField>
          <FormField label="Anti-theft devices fitted">
            <select
              value={form.anti_theft_devices}
              onChange={(e) => updateField("anti_theft_devices", e.target.value)}
              style={formInputStyle}
            >
              <option value="none">None</option>
              <option value="tracking_only">Tracking only</option>
              <option value="tracking_and_immobiliser">Tracking + immobiliser</option>
            </select>
          </FormField>
        </div>
      </div>

      <button
        className="tx-btn"
        onClick={computeQuote}
        style={{
          background: "#14213D",
          color: "#FAF7F0",
          border: "none",
          borderRadius: "5px",
          padding: "10px 20px",
          fontSize: "0.9rem",
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: "'Inter', sans-serif",
          marginBottom: "24px",
        }}
      >
        Compute quote
      </button>

      {result && !result.error && result.verdict.startsWith("DECLINE - Auto-decline") && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "20px", marginBottom: "20px" }}>
            <StampBadge verdict="DECLINE" />
            <div>
              <div style={{ fontSize: "0.95rem", fontWeight: 600, color: "#14213D", lineHeight: 1.4 }}>
                {(result.auto_decline_reasons && result.auto_decline_reasons[0]) || "Auto-decline triggered"}
              </div>
              <div style={{ fontSize: "0.75rem", color: "#5C6570", marginTop: "2px" }}>
                No premium calculated - hard auto-decline rule triggered
              </div>
            </div>
          </div>
          {(result.auto_decline_reasons || []).length > 1 && (
            <div>
              <SectionLabel>All auto-decline reasons</SectionLabel>
              <ul style={{ margin: "8px 0 0", paddingLeft: "18px", fontSize: "0.82rem", color: "#5C6570", lineHeight: 1.6 }}>
                {result.auto_decline_reasons.map((reason, i) => (
                  <li key={i}>{reason}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {result && !result.error && !result.verdict.startsWith("DECLINE - Auto-decline") && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "20px", marginBottom: "24px" }}>
            <StampBadge
              verdict={
                result.verdict.startsWith("ACCEPT")
                  ? "ACCEPT"
                  : result.verdict.startsWith("CONDITIONAL ACCEPT")
                  ? "CONDITIONAL ACCEPT"
                  : "DECLINE"
              }
            />
            <div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "1.4rem", fontWeight: 700 }}>
                {result.risk_adjusted_premium != null ? "R" + result.risk_adjusted_premium.toLocaleString() : "\u2014"}
              </div>
              <div style={{ fontSize: "0.75rem", color: "#5C6570" }}>Risk-adjusted annual premium</div>
            </div>
          </div>

          <div style={{ background: "#F1ECE0", borderRadius: "6px", padding: "16px 18px", marginBottom: "20px" }}>
            <div style={{ fontSize: "0.9rem", lineHeight: 1.5 }}>{result.verdict}</div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "10px", marginBottom: "22px" }}>
            <StatBox label="Weighted telematics score" value={result.weighted_telematics_score} />
            <StatBox label="Combined telematics score" value={result.combined_telematics_score} />
            <StatBox label="Rating factor" value={result.rating_factor != null ? result.rating_factor.toFixed(2) + "x" : "\u2014"} />
            <StatBox label="Combined rating factor" value={result.combined_rating_factor != null ? result.combined_rating_factor.toFixed(2) + "x" : "\u2014"} />
            <StatBox label="Total fleet sum insured" value={"R" + result.total_fleet_sum_insured.toLocaleString()} />
            <StatBox label="Market rate base premium" value={"R" + result.market_rate_base_premium.toLocaleString()} />
            <StatBox
              label="Premium saving vs market"
              value={result.premium_saving_vs_market > 0 ? "R" + result.premium_saving_vs_market.toLocaleString() : "\u2014"}
            />
            <StatBox
              label="Additional premium vs market"
              value={result.additional_premium_vs_market > 0 ? "R" + result.additional_premium_vs_market.toLocaleString() : "\u2014"}
            />
            <StatBox label="Management fee (11%)" value={"R" + result.management_fee.toLocaleString()} />
            <StatBox
              label="Fleet size tier"
              value={
                result.fleet_size_multiplier != null
                  ? (HCV_FLEET_SIZE_TIERS.find((t) => form.vehicle_count >= t.minVehicles && form.vehicle_count <= t.maxVehicles) || HCV_FLEET_SIZE_TIERS[HCV_FLEET_SIZE_TIERS.length - 1]).label + " (" + result.fleet_size_multiplier.toFixed(2) + "x)"
                  : "\u2014"
              }
            />
            <StatBox
              label="Static risk score (7-item)"
              value={result.static_risk_score != null ? result.static_risk_score.toFixed(1) : "Not scored -- using Yes/No flag"}
            />
          </div>

          <div>
            <SectionLabel>SA market loading breakdown</SectionLabel>
            <ul style={{ margin: "8px 0 0", paddingLeft: "18px", fontSize: "0.82rem", color: "#5C6570", lineHeight: 1.6 }}>
              <li>Manufacturer ({form.manufacturer.replace(/_/g, " ")}): {(result.manufacturer_loading * 100).toFixed(0)}%</li>
              <li>Vehicle age band ({result.age_band.replace(/_/g, " ")}): {(result.age_band_loading * 100).toFixed(0)}%</li>
              <li>Cargo / peril ({form.cargo_type.replace(/_/g, " ")}): {(result.cargo_loading * 100).toFixed(0)}%</li>
              <li>Corridor / route ({form.operating_corridor.replace(/_/g, " ")}): {(result.corridor_loading * 100).toFixed(0)}%</li>
              <li>Anti-theft device credit: {(result.anti_theft_credit * 100).toFixed(0)}%</li>
              <li>Night operations: {(result.night_ops_loading * 100).toFixed(0)}%</li>
              <li>Claims experience{form.loss_ratio_pct != null ? ` (${form.loss_ratio_pct}% loss ratio)` : " (no claims history)"}: {(result.claims_experience_loading * 100).toFixed(0)}%</li>
              <li><strong>Total SA market loading: {(result.total_sa_market_loading * 100).toFixed(0)}%</strong></li>
            </ul>
          </div>
          <div style={{ marginTop: "16px", textAlign: "right" }}>
            <button
              className="tx-btn"
              onClick={() => generateHcvQuotePDF(form, result)}
              style={{ background: "#14213D", color: "#fff", border: "none", padding: "10px 24px", borderRadius: "6px", fontSize: "0.88rem", cursor: "pointer", fontWeight: 600 }}
            >
              Download Quote (PDF)
            </button>
          </div>
        </div>
      )}
      {result && result.error && (
        <div style={{ color: "#B23A2E", fontSize: "0.85rem", fontFamily: "'IBM Plex Mono', monospace" }}>
          {result.error}
        </div>
      )}
    </div>
  );
}

function makeFleetInfoDefaults() {
  return {
    // Shared
    fleet_name: "",
    vehicle_count: 0,
    // HCV block
    asset_class: "hcv_general_freight",
    avg_sum_insured_per_vehicle: 0,
    manufacturer: "mercedes_benz",
    year_model: null,
    avg_km_per_vehicle_month: 0,
    cargo_type: "general_merchandise",
    operating_corridor: "mixed_sa_national",
    night_ops_pct: 0.0,
    anti_theft_devices: "none",
    trend_direction: "stable",
    device_concealment_events_per_month: 0,
    static_questionnaire_complete: true,
    // HCV data-source qualifier (Frans-confirmed Aug 2026 — replaces binary telemetry_available)
    hcv_data_source: "none",
    // Static questionnaire (7 items, 4-tier rubric)
    sq_driving_hour_policy: null,
    sq_max_speed_policy: null,
    sq_telematics_driver_mgmt: null,
    sq_route_distance_mgmt: null,
    sq_driver_training: null,
    sq_driver_employment: null,
    sq_driver_remuneration: null,
    // GIT block
    load_limit_per_vehicle: 0,
    commodity_type: "general_cargo",
    geographic_zone: "western_cape",
    claims_history: "clean",
    loss_ratio_pct: null,
    cover_type: "all_risks",
    fleet_age: "new",
    night_ops: "under_30pct",
    cross_border: "local",
    iot_devices_fitted: [],
    cargosnap_fitted: false,
    cvtscpi_rmp_tier: "none",
    is_high_value_cargo: false,
    is_rmp1_scoped: false,
  };
}

function FleetInformationView({ sharedFleetInfo, onSave }) {
  const [form, setForm] = useState({ ...makeFleetInfoDefaults(), ...(sharedFleetInfo || {}) });
  const [saved, setSaved] = useState(false);
  const [extractStatus, setExtractStatus] = useState("idle"); // idle | reading | extracting | done | error
  const [extractError, setExtractError] = useState(null);
  const [extractNotes, setExtractNotes] = useState(null);
  const [extractKey, setExtractKey] = useState(0); // increments on each extraction to force form re-render
  const [dragOver, setDragOver] = useState(false);
  const [uploadedFileNames, setUploadedFileNames] = useState([]);
  const fileInputRef = useRef(null);

  const updateField = (key, value) => {
    setSaved(false);
    setForm((f) => ({ ...f, [key]: value }));
  };

  const toggleIotDevice = (device) => {
    setSaved(false);
    setForm((f) => {
      const has = f.iot_devices_fitted.includes(device);
      return {
        ...f,
        iot_devices_fitted: has
          ? f.iot_devices_fitted.filter((d) => d !== device)
          : [...f.iot_devices_fitted, device],
      };
    });
  };

  const handleSave = () => {
    onSave(form);
    setSaved(true);
  };

  // --- Document extraction ---
  const FLEET_INFO_EXTRACTION_PROMPT = `You are a data extraction tool for a South African HCV/GIT fleet insurance underwriter. You will be shown a PDF document — it could be a policy schedule, a fleet listing, a quote document, a broker submission, a needs analysis form, or any document containing fleet and cargo details.

CRITICAL PRIVACY RULE: Never extract, repeat, or reference any personal identifying information — this includes ID numbers, passport numbers, dates of birth, banking details, or any government-issued identifier, even if visible in the document. If the insured's name is needed for context, use it, but never include ID/identity numbers anywhere in your output, including extraction_notes. This applies regardless of how clearly the document displays such numbers.

Extract ONLY what is explicitly stated in the document. Do not guess or invent values that aren't grounded in the document.

CRITICAL VEHICLE SPLIT RULE: South African fleet schedules almost always contain BOTH HCV trucks AND trailers in the same document. You MUST split them:
- hcv_truck_count: count ONLY the HCV motor vehicles (trucks, tractors, horse units). Look for section headers like "HCV", "TRUCKS", "MOTOR VEHICLES", "HORSE UNITS" or asset descriptions containing "ACTROS", "ARGOSY", "SCANIA", "VOLVO FH", "FREIGHTLINER", "INTERNATIONAL", "MAN TGA", "FAW", etc. Do NOT count trailers, LDVs, bakkies, or light vehicles here.
- trailer_count: count ONLY trailers, semi-trailers, and interlinks. Look for section headers like "TRAILERS", "SEMI-TRAILERS" or descriptions containing "TAUTLINER", "FLATDECK", "SIDE TIPPER", "INTERLINK", "AFRIT", "GRW", "SATB", "HENRED".
- hcv_truck_avg_sum_insured: sum the insured values of HCV trucks only, divide by hcv_truck_count.
- trailer_avg_sum_insured: sum the insured values of trailers only, divide by trailer_count.
- vehicle_count: set to hcv_truck_count (HCV trucks only — trailers are rated separately).
- avg_sum_insured_per_vehicle: set to hcv_truck_avg_sum_insured.
If no section header exists, use asset descriptions to classify. Note your classification in extraction_notes.
For every OTHER field, remain conservative: only fill from what's explicitly stated or a clear closest-match, and set to null if genuinely unclear.

Map the extracted values to the closest matching option from the allowed values listed below. If no option matches, use the closest reasonable match and note it in extraction_notes.

Return ONLY valid JSON (no markdown fences, no prose) in this exact shape:
{
  "fleet_name": string or null,
  "hcv_truck_count": number or null,
  "trailer_count": number or null,
  "hcv_truck_avg_sum_insured": number or null,
  "trailer_avg_sum_insured": number or null,
  "vehicle_count": number or null,
  "asset_class": one of ["hcv_general_freight","fuel_hazmat_tanker","minerals_bulk_long_haul","fmcg_distribution","bulk_liquids_non_hazmat","yellow_metal_plant","agricultural_equipment","refrigerated_cold_chain","abnormal_loads_oversized","drone_commercial"] or null,
  "avg_sum_insured_per_vehicle": number or null,
  "manufacturer": one of ["daf","faw","freightliner","hino","isuzu","man","mercedes_benz","other","scania","ud_trucks","volvo","western_star"] or null,
  "year_model": number (4-digit year, computed as the arithmetic average of all HCV truck year models rounded to nearest year — e.g. if trucks are 2003, 2006, 2007, 2010, 2013, 2003 then average = (2003+2006+2007+2010+2013+2003)/6 = 2007; always compute this if individual years are visible, do not leave null) or null,
  "avg_km_per_vehicle_month": number or null,
  "cargo_type": one of ["agricultural_produce","chemicals_hazmat_adr","chemicals_non_hazmat","electronics_high_value","fmcg_food_bev","fuel_petroleum","general_merchandise","livestock","minerals_mining","refrigerated","retail_clothing","steel_metals"] or null,
  "operating_corridor": one of ["cross_border_sadc","kwazulu_natal_regional","mixed_sa_national","n1_cape_johannesburg","n1_north_limpopo_zimbabwe_border","n12_east_rand_port_elizabeth","n14_n4_botswana_border","n3_johannesburg_durban","northern_cape_manganese_routes","western_cape_regional"] or null,
  "night_ops_pct": number (0-100) or null. If document says YES to night driving between 22:00-05:00 with no percentage given, set to 35. If NO, set to 0,
  "anti_theft_devices": one of ["none","tracking_only","tracking_immobiliser"] or null,
  "load_limit_per_vehicle": number or null,
  "commodity_type": one of ["agricultural_grain","alcohol_beverages","ammunition_explosives_fireworks","antiques_artworks","automotive_parts","bloodstock_game","building_materials","bullion_cash_treasury_notes","cameras_cellphones_accessories","coal_mining_bulk","cobalt","computers_memory_systems","copper_any_form","documents_specie_stamps_tickets","electronics_tech","fmcg_branded_high_risk","fmcg_retail_general","fuel_petroleum","general_cargo","gold_silver_jewellery_watches_furs","machinery_equipment","metals_steel_chrome","non_ferrous_metals","pharmaceuticals","prepaid_phone_cards","refrigerated_goods","timber_paper","tobacco_cigars_cigarettes"] or null,
  "geographic_zone": one of ["western_cape","medium_risk","gauteng_high_risk"] or null,
  "claims_history": one of ["clean","one_claim"] or null,
  "loss_ratio_pct": number or null,
  "cover_type": one of ["all_risks","fire_collision_overturning_theft_hijack","fire_collision_overturning_only"] or null,
  "iot_devices": [string] or null,\n  "hcv_data_source": one of ["none","oem_only","oem_video"] or null,
  "is_high_value_cargo": boolean or null,
  "is_rmp1_scoped": boolean or null,
  "cargosnap_fitted": boolean or null,
  "security_device": one of ["none","rmp1_top_lock","rmp2_cable_lock","rmp3_tracktag"] or null,
  "vehicle_register": [
    {
      "registration": string,
      "make": string,
      "model": string,
      "year": number,
      "insured_value": number,
      "cover": "comp" | "specified" | "tpl_only",
      "asset_type": "hcv" | "trailer" | "ldv" | "other"
    }
  ] or [],
  "extraction_notes": string
}\`;

VEHICLE REGISTER RULES:
- Always populate vehicle_register from any vehicle schedule in the document.
- List EVERY vehicle and trailer individually — one object per line item.
- asset_type: "hcv" for trucks/horses/tractors, "trailer" for all trailer types, "ldv" for bakkies/light vehicles, "other" for anything else.
- cover: "comp" for comprehensive, "specified" for specified perils, "tpl_only" for TPL only.
- insured_value: the individual agreed/retail/market value per vehicle from the schedule.
- registration: the reg number as printed. If not visible, use "unknown".
- make: the manufacturer name (e.g. "Scania", "Freightliner", "Mercedes-Benz").
- model: the full model description as printed (e.g. "R420 CA 6X4 ESZ T/T C/C").
- year: the model year as a 4-digit integer.
- IoT/telematics mapping: if document mentions cameras (2x or 4x), add "dashcam_front_rear" to iot_devices. If telematics supplier named (C-Track, MiX, Cartrack, Netstar, Ctrack, Track), set hcv_data_source to "oem_only". If supplier named AND video cameras confirmed, set hcv_data_source to "oem_video". If no telematics mentioned, set hcv_data_source to "none".\n\nDo NOT group vehicles — one row per vehicle, always.`;

  const processDocument = useCallback(async (file) => {
    if (!file) return;
    const name = file.name.toLowerCase();
    const isPdf = file.type === "application/pdf" || name.endsWith(".pdf");
    const isExcel = name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".csv");

    if (!isPdf && !isExcel) {
      setExtractStatus("error");
      setExtractError("Please provide a PDF or Excel (.xlsx/.xls/.csv) file.");
      return;
    }
    setExtractStatus("reading");
    setExtractError(null);
    setExtractNotes(null);

    // Pre-computed JS figures (Excel only — remain 0 for PDF path)
    let jsVehicleCount = 0;
    let jsTotalSumInsured = 0;
    let jsTrucks   = [];
    let jsTrailers = [];
    let jsFallbackRows = [];

    try {
      let requestBody;

      if (isExcel) {
        // Parse Excel/CSV client-side using SheetJS
        // XLSX already statically imported at top of file
        const arrayBuffer = await file.arrayBuffer();
        const workbook = XLSX.read(arrayBuffer, { type: "array" });

        // Pre-compute vehicle count and sum insured in JavaScript (do NOT trust AI arithmetic)
        // Supports both Afrikaans-section-headed files (VRAGMOTORS / TRAILERS with JAAR/MAAK/MODEL/WAARDE)
        // and English-column files (SUM INSURED / INSURED VALUE).

        // Helper: parse a numeric value from a cell (handles "R 1,234,567" formats)
        const parseNum = (v) => {
          const n = parseFloat(String(v == null ? "" : v).replace(/[^0-9.]/g, ""));
          return isNaN(n) ? 0 : n;
        };

        // Helper: find the column index whose uppercased header matches any of the given substrings
        const colIdx = (headers, ...candidates) =>
          headers.findIndex(h => candidates.some(c => h.includes(c)));

        // Helper: parse one section of rows (from after section-header row to next blank/section boundary)
        // Returns array of { year, make, model, reg, vin, insured_value }
        const parseSection = (rows, startIdx) => {
          const vehicles = [];
          // The row at startIdx is the section label (e.g. "VRAGMOTORS") — skip it
          // Next non-empty row should be the column header row
          let colHeaderIdx = -1;
          for (let i = startIdx + 1; i < rows.length && i < startIdx + 5; i++) {
            const r = rows[i];
            const upper = r.map(c => String(c == null ? "" : c).toUpperCase().trim());
            if (upper.some(c => c === "JAAR" || c === "MAAK" || c === "MODEL" || c === "REG NO" || c.includes("INSURED") || c === "WAARDE" || c.includes("AGREED"))) {
              colHeaderIdx = i;
              break;
            }
          }
          if (colHeaderIdx < 0) return vehicles;

          const hdrs = rows[colHeaderIdx].map(c => String(c == null ? "" : c).toUpperCase().trim());
          // Map Afrikaans and English column names to indices
          const iYear  = colIdx(hdrs, "JAAR", "YEAR", "MODEL YEAR");
          const iMake  = colIdx(hdrs, "MAAK", "MAKE", "MANUFACTURER");
          const iModel = colIdx(hdrs, "MODEL");
          const iReg   = colIdx(hdrs, "REG NO", "REGISTRATION", "REG");
          const iVin   = colIdx(hdrs, "VIN NO", "VIN", "CHASSIS");
          // Value column: prefer "AGREED VALUE" over bare "WAARDE" or "VALUE"
          let iVal = colIdx(hdrs, "AGREED VALUE");
          if (iVal < 0) iVal = colIdx(hdrs, "WAARDE", "SUM INSURED", "INSURED VALUE");
          if (iVal < 0) iVal = colIdx(hdrs, "VALUE");

          for (let i = colHeaderIdx + 1; i < rows.length; i++) {
            const row = rows[i];
            if (!row || row.every(c => c === "" || c == null)) break; // blank row = end of section
            // Stop if we hit another section header
            const firstCell = String(row[0] == null ? "" : row[0]).toUpperCase().trim();
            if (firstCell.startsWith("VRAGMOTORS") || firstCell.startsWith("TRAILERS") || firstCell.startsWith("SEMI-TRAILERS")) break;
            if (iVal < 0) continue;
            const val = parseNum(row[iVal]);
            if (val <= 0) continue;
            // Skip totals/summary rows — they have a value but no make and no registration
            const rowMake = iMake >= 0 ? String(row[iMake] == null ? "" : row[iMake]).trim() : "";
            const rowReg  = iReg  >= 0 ? String(row[iReg]  == null ? "" : row[iReg]).trim()  : "";
            if (!rowMake && !rowReg) continue;
            vehicles.push({
              year:          iYear  >= 0 ? parseInt(String(row[iYear]),  10) || null : null,
              make:          iMake  >= 0 ? String(row[iMake]  == null ? "" : row[iMake]).trim()  : "",
              model:         iModel >= 0 ? String(row[iModel] == null ? "" : row[iModel]).trim() : "",
              reg:           iReg   >= 0 ? String(row[iReg]   == null ? "" : row[iReg]).trim()   : "unknown",
              vin:           iVin   >= 0 ? String(row[iVin]   == null ? "" : row[iVin]).trim()   : "",
              insured_value: val,
            });
          }
          return vehicles;
        };

        // Main parse loop — try Afrikaans section detection first, fall back to English
        workbook.SheetNames.forEach((sheetName) => {
          const sheet = workbook.Sheets[sheetName];
          const rows  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
          if (rows.length < 2) return;

          // Scan for Afrikaans section headers (VRAGMOTORS = trucks, TRAILERS = trailers)
          // Use startsWith to handle variants like "VRAGMOTORS : " or "TRAILERS :"
          let foundSections = false;
          for (let i = 0; i < rows.length; i++) {
            const firstCell = String(rows[i][0] == null ? "" : rows[i][0]).toUpperCase().trim();
            if (firstCell.startsWith("VRAGMOTORS")) {
              jsTrucks   = jsTrucks.concat(parseSection(rows, i));
              foundSections = true;
            } else if (firstCell.startsWith("TRAILERS") || firstCell.startsWith("SEMI-TRAILERS")) {
              jsTrailers = jsTrailers.concat(parseSection(rows, i));
              foundSections = true;
            }
          }

          if (!foundSections) {
            // English-column fallback: find the first row with INSURED/VALUE header
            const headerIdx = rows.findIndex(r =>
              r.some(c => String(c).toUpperCase().includes("INSURED") || String(c).toUpperCase().includes("VALUE"))
            );
            if (headerIdx < 0) return;
            const hdrs  = rows[headerIdx].map(c => String(c == null ? "" : c).toUpperCase().trim());
            let iVal = colIdx(hdrs, "SUM INSURED", "INSURED VALUE", "AGREED VALUE");
            if (iVal < 0) iVal = colIdx(hdrs, "INSURED");
            if (iVal < 0) return;
            for (let i = headerIdx + 1; i < rows.length; i++) {
              const row = rows[i];
              if (!row || row.every(c => c === "" || c == null)) continue;
              const val = parseNum(row[iVal]);
              if (val > 0) jsFallbackRows.push({ insured_value: val });
            }
          }
        });

        // Determine final counts
        if (jsTrucks.length > 0 || jsTrailers.length > 0) {
          // Afrikaans-section path: trucks only feed vehicle_count (trailers rated separately)
          jsVehicleCount   = jsTrucks.length;
          jsTotalSumInsured = jsTrucks.reduce((s, v) => s + v.insured_value, 0);
        } else if (jsFallbackRows.length > 0) {
          // English-column fallback: treat all as vehicles
          jsVehicleCount   = jsFallbackRows.length;
          jsTotalSumInsured = jsFallbackRows.reduce((s, v) => s + v.insured_value, 0);
        }

        // Build CSV for AI — when JS has already parsed trucks/trailers authoritatively,
        // only send the first ~30 rows (enough for fleet name, cargo, corridor, zone).
        // Sending all 100+ rows hits the token limit and truncates the JSON response.
        const jsAlreadyParsed = jsTrucks.length > 0 || jsTrailers.length > 0;
        const csvSheets = workbook.SheetNames.map((sheetName) => {
          const sheet = workbook.Sheets[sheetName];
          const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
          const rowsToSend = jsAlreadyParsed ? rows.slice(0, 30) : rows;
          // Convert trimmed rows back to CSV
          const csv = rowsToSend.map(r => r.map(c => {
            const s = String(c == null ? "" : c);
            return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
          }).join(",")).join("\n");
          return `Sheet: ${sheetName}\n${csv}`;
        }).join("\n\n");

        setExtractStatus("extracting");
        const preComputedNote = jsVehicleCount > 0
          ? `IMPORTANT: JavaScript has already counted and summed the fleet schedule. Use these pre-computed figures exactly — do NOT recount or resum:\n- vehicle_count: ${jsVehicleCount}\n- total_sum_insured: ${jsTotalSumInsured}\n- avg_sum_insured_per_vehicle: ${Math.round(jsTotalSumInsured / jsVehicleCount)}\n`
          : "";

        requestBody = JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 8000,
          system: "You are a data extraction assistant. You MUST respond with valid JSON only. No preamble, no explanation, no markdown fences. Your entire response must be a single valid JSON object.",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: `Extract fleet data from the following Excel content (converted to CSV). Return ONLY a valid JSON object — no text before or after it, no markdown fences.\n\n${preComputedNote}\nExcel content:\n${csvSheets}\n\n${FLEET_INFO_EXTRACTION_PROMPT}` },
              ],
            },
          ],
        });
      } else {
        const b64 = await fileToBase64(file);
        setExtractStatus("extracting");
        requestBody = JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 4000,
          messages: [
            {
              role: "user",
              content: [
                { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
                { type: "text", text: FLEET_INFO_EXTRACTION_PROMPT },
              ],
            },
          ],
        });
      }

      const response = await fetch("https://telematix-rater-backend.onrender.com/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
      });

      const data = await response.json();
      let rawText = (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      rawText = rawText.trim();
      if (rawText.startsWith("```")) {
        rawText = rawText.replace(/^```(json)?/, "").replace(/```$/, "").trim();
      }

      const extracted = JSON.parse(rawText);

      // Inject JS pre-computed figures (Excel path only — jsVehicleCount=0 for PDF)
      // When Afrikaans sections were parsed (jsTrucks/jsTrailers populated), JS data is authoritative
      // for vehicle_register, vehicle_count, and sum-insured — overwrite AI output unconditionally.
      const mfrMap = { scania: "scania", "mercedes-benz": "mercedes_benz", mercedesbenz: "mercedes_benz",
        freightliner: "freightliner", volvo: "volvo", man: "man", daf: "daf", faw: "faw",
        hino: "hino", isuzu: "isuzu", international: "other", western_star: "western_star" };

      if (jsTrucks.length > 0 || jsTrailers.length > 0) {
        // Build vehicle_register from JS-parsed rows (authoritative for Afrikaans schedule)
        const truckRegister = jsTrucks.map(v => ({
          registration:  v.reg   || "unknown",
          make:          v.make  || "",
          model:         v.model || "",
          year:          v.year  || null,
          insured_value: v.insured_value,
          cover_type:    "comprehensive",
          asset_type:    "hcv",
        }));
        const trailerRegister = jsTrailers.map(v => ({
          registration:  v.reg   || "unknown",
          make:          v.make  || "",
          model:         v.model || "",
          year:          v.year  || null,
          insured_value: v.insured_value,
          cover_type:    "comprehensive",
          asset_type:    "trailer",
        }));
        extracted.vehicle_register = [...truckRegister, ...trailerRegister];
        // Authoritative counts and values from JS parse
        extracted.hcv_truck_count  = jsTrucks.length;
        extracted.trailer_count    = jsTrailers.length;
        extracted.vehicle_count    = jsTrucks.length;
        const truckSI = jsTrucks.reduce((s, v) => s + v.insured_value, 0);
        const trailerSI = jsTrailers.reduce((s, v) => s + v.insured_value, 0);
        extracted.hcv_truck_avg_sum_insured = jsTrucks.length  > 0 ? Math.round(truckSI   / jsTrucks.length)   : null;
        extracted.trailer_avg_sum_insured   = jsTrailers.length > 0 ? Math.round(trailerSI / jsTrailers.length) : null;
        extracted.avg_sum_insured_per_vehicle = extracted.hcv_truck_avg_sum_insured;
        // Dominant manufacturer from trucks
        const makes = jsTrucks.map(v => v.make?.toLowerCase().trim()).filter(Boolean);
        const mc = {}; makes.forEach(m => { mc[m] = (mc[m] || 0) + 1; });
        const dom = Object.entries(mc).sort((a, b) => b[1] - a[1])[0]?.[0];
        if (dom) extracted.manufacturer = mfrMap[dom] || "other";
        // Average year model from trucks
        const years = jsTrucks.map(v => v.year).filter(y => y > 1980 && y <= 2030);
        if (years.length > 0) extracted.year_model = Math.round(years.reduce((s, y) => s + y, 0) / years.length);
      } else if (jsVehicleCount > 0) {
        // English-column fallback: inject totals only if AI missed them
        if (extracted.vehicle_count == null || extracted.vehicle_count === 0) extracted.vehicle_count = jsVehicleCount;
        if (extracted.avg_sum_insured_per_vehicle == null || extracted.avg_sum_insured_per_vehicle === 0) {
          extracted.avg_sum_insured_per_vehicle = Math.round(jsTotalSumInsured / jsVehicleCount);
        }
      }

      // Map extracted values into form fields (only overwrite non-null extractions)
      setForm((prev) => {
        const updated = { ...prev };
        if (extracted.vehicle_register && extracted.vehicle_register.length > 0) {
          // Only replace vehicle_register if the new one is larger — prevents a PDF's shorter
          // conveyance list from overwriting an Excel's full truck+trailer register
          const existingReg = prev.vehicle_register || [];
          if (extracted.vehicle_register.length >= existingReg.length) {
            updated.vehicle_register = extracted.vehicle_register;
          }
          const regToUse = updated.vehicle_register;
          // Auto-compute truck/trailer splits from register
          const trucks = regToUse.filter(v => v.asset_type === "hcv");
          const trailers = regToUse.filter(v => v.asset_type === "trailer");
          if (trucks.length > 0) {
            updated.hcv_truck_count = trucks.length;
            updated.vehicle_count = trucks.length;
            const truckSI = trucks.reduce((s, v) => s + (v.insured_value || 0), 0);
            updated.hcv_truck_avg_sum_insured = Math.round(truckSI / trucks.length);
            updated.avg_sum_insured_per_vehicle = Math.round(truckSI / trucks.length);
            // Average year model from truck years
            const years = trucks.map(v => v.year).filter(y => y > 1980 && y <= 2030);
            if (years.length > 0) updated.year_model = Math.round(years.reduce((s, y) => s + y, 0) / years.length);
            // Dominant manufacturer
            const makes = trucks.map(v => v.make?.toLowerCase());
            const makeCount = {};
            makes.forEach(m => { makeCount[m] = (makeCount[m] || 0) + 1; });
            const dominant = Object.entries(makeCount).sort((a, b) => b[1] - a[1])[0]?.[0];
            const mfrMap = { scania: "scania", "mercedes-benz": "mercedes_benz", mercedesbenz: "mercedes_benz", freightliner: "freightliner", volvo: "volvo", man: "man", daf: "daf", faw: "faw", hino: "hino", isuzu: "isuzu", international: "other", western_star: "western_star" };
            updated.manufacturer = mfrMap[dominant] || "other";
          }
          if (trailers.length > 0) {
            updated.trailer_count = trailers.length;
            const trailerSI = trailers.reduce((s, v) => s + (v.insured_value || 0), 0);
            updated.trailer_avg_sum_insured = Math.round(trailerSI / trailers.length);
          }
        }
        if (extracted.fleet_name) updated.fleet_name = extracted.fleet_name;
        if (extracted.hcv_truck_count != null) updated.hcv_truck_count = extracted.hcv_truck_count;
        if (extracted.trailer_count != null) updated.trailer_count = extracted.trailer_count;
        if (extracted.hcv_truck_avg_sum_insured != null) updated.hcv_truck_avg_sum_insured = extracted.hcv_truck_avg_sum_insured;
        if (extracted.trailer_avg_sum_insured != null) updated.trailer_avg_sum_insured = extracted.trailer_avg_sum_insured;
        // vehicle_count and avg_sum_insured now come from truck-specific fields
        if (extracted.hcv_truck_count != null) updated.vehicle_count = extracted.hcv_truck_count;
        if (extracted.hcv_truck_avg_sum_insured != null) updated.avg_sum_insured_per_vehicle = extracted.hcv_truck_avg_sum_insured;
        // Fallback: if no truck/trailer split available, use total
        if (extracted.hcv_truck_count == null && extracted.vehicle_count != null) updated.vehicle_count = extracted.vehicle_count;
        if (extracted.asset_class) updated.asset_class = extracted.asset_class;
        if (extracted.avg_sum_insured_per_vehicle != null) updated.avg_sum_insured_per_vehicle = extracted.avg_sum_insured_per_vehicle;
        if (extracted.manufacturer) updated.manufacturer = extracted.manufacturer;
        if (extracted.year_model != null) updated.year_model = extracted.year_model;
        if (extracted.avg_km_per_vehicle_month != null) updated.avg_km_per_vehicle_month = extracted.avg_km_per_vehicle_month;
        if (extracted.cargo_type) updated.cargo_type = extracted.cargo_type;
        if (extracted.operating_corridor) updated.operating_corridor = extracted.operating_corridor;
        if (extracted.night_ops_pct != null) updated.night_ops_pct = extracted.night_ops_pct > 1 ? extracted.night_ops_pct / 100 : extracted.night_ops_pct;
        if (extracted.anti_theft_devices) updated.anti_theft_devices = extracted.anti_theft_devices;
        if (extracted.load_limit_per_vehicle != null) updated.load_limit_per_vehicle = extracted.load_limit_per_vehicle;
        if (extracted.commodity_type) updated.commodity_type = extracted.commodity_type;
        if (extracted.geographic_zone) updated.geographic_zone = extracted.geographic_zone;
        if (extracted.claims_history) updated.claims_history = extracted.claims_history;
        if (extracted.loss_ratio_pct != null) updated.loss_ratio_pct = extracted.loss_ratio_pct;
        if (extracted.cover_type) updated.cover_type = extracted.cover_type;
        if (Array.isArray(extracted.iot_devices) && extracted.iot_devices.length > 0) updated.iot_devices_fitted = extracted.iot_devices;
        if (extracted.hcv_data_source && extracted.hcv_data_source !== "none") { if (!updated.hcv_data_source || updated.hcv_data_source === "none") updated.hcv_data_source = extracted.hcv_data_source; }
        if (extracted.is_high_value_cargo != null) updated.is_high_value_cargo = extracted.is_high_value_cargo;
        if (extracted.is_rmp1_scoped != null) updated.is_rmp1_scoped = extracted.is_rmp1_scoped;
        if (extracted.cargosnap_fitted != null) updated.cargosnap_fitted = extracted.cargosnap_fitted;
        if (extracted.security_device) updated.cvtscpi_rmp_tier = extracted.security_device;
        return updated;
      });

      setExtractNotes(extracted.extraction_notes || null);
      setExtractStatus("done");
      setSaved(false);
      setExtractKey((k) => k + 1); // force form fields to re-render with new values
    } catch (err) {
      setExtractStatus("error");
      setExtractError("Extraction failed: " + (err.message || String(err)));
    }
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    setUploadedFileNames(files.map(f => f.name));
    // Process files sequentially — each extraction merges into form state
    files.reduce((chain, file) => chain.then(() => processDocument(file)), Promise.resolve());
  }, [processDocument]);

  const handleFileSelect = useCallback((e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;
    setUploadedFileNames(files.map(f => f.name));
    files.reduce((chain, file) => chain.then(() => processDocument(file)), Promise.resolve());
    e.target.value = ""; // reset so same file can be re-selected
  }, [processDocument]);

  return (
    <div>
      <div
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: "0.75rem",
          color: "#B5762A",
          marginBottom: "16px",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        Fleet Information
      </div>
      <div style={{ fontSize: "0.82rem", color: "#5C6570", marginBottom: "20px", lineHeight: 1.5 }}>
        Capture fleet details here once — they carry through to Risk Scoring and Multi-Cohort automatically. Fill in as much as you have; fields can be adjusted at each step.
      </div>

      {/* Document upload zone */}
      <div style={{ marginBottom: "24px" }}>
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          style={{
            border: `2px dashed ${dragOver ? "#B5762A" : "#CCC"}`,
            borderRadius: "8px",
            padding: "20px",
            textAlign: "center",
            cursor: "pointer",
            background: dragOver ? "rgba(181,118,42,0.05)" : "transparent",
            transition: "all 0.2s",
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.xlsx,.xls,.csv"
            multiple
            onChange={handleFileSelect}
            style={{ display: "none" }}
          />
          <div style={{ fontSize: "0.88rem", color: "#14213D", fontWeight: 600 }}>
            {extractStatus === "idle" && "Drop one or more files here, or click to upload — PDF, Excel or CSV (fleet schedule, policy, quote)"}
            {extractStatus === "reading" && `Reading ${uploadedFileNames.length > 1 ? uploadedFileNames.length + " files" : "document"}...`}
            {extractStatus === "extracting" && `Extracting fleet details${uploadedFileNames.length > 1 ? " (" + uploadedFileNames.length + " files)" : ""} — this takes a few seconds...`}
            {extractStatus === "done" && `Extraction complete${uploadedFileNames.length > 1 ? " (" + uploadedFileNames.length + " files merged)" : ""} — fields populated below. Review and edit before saving.`}
            {extractStatus === "error" && "Extraction failed — fill in manually below."}
          </div>
          {uploadedFileNames.length > 0 && (
            <div style={{ fontSize: "0.75rem", color: "#666", marginTop: "6px" }}>
              {uploadedFileNames.map((n, i) => (
                <span key={i} style={{ display: "inline-block", background: "#f0f0f0", borderRadius: "3px", padding: "1px 6px", margin: "2px 3px 2px 0" }}>
                  {n}
                </span>
              ))}
            </div>
          )}
          {extractStatus === "done" && (
            <div style={{ fontSize: "0.78rem", color: "#3D6B4F", marginTop: "6px" }}>
              Fields have been auto-filled from your document. Check each value below — the AI extracts, you confirm.
            </div>
          )}
          {extractError && (
            <div style={{ fontSize: "0.78rem", color: "#B23A2E", marginTop: "6px" }}>{extractError}</div>
          )}
          {extractNotes && (
            <div style={{ fontSize: "0.78rem", color: "#B5762A", marginTop: "6px" }}>Notes: {extractNotes}</div>
          )}

        </div>
      </div>

      {/* Shared section — key forces re-render after extraction populates form state */}
      <div key={`form-${extractKey}`} style={{ marginBottom: "20px" }}>
        <SectionLabel>Shared fleet details</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "12px", marginTop: "12px" }}>
          <FormField label="Fleet name">
            <input
              type="text"
              value={form.fleet_name}
              onChange={(e) => updateField("fleet_name", e.target.value)}
              style={formInputStyle}
            />
          </FormField>
          <FormField label="Number of vehicles">
            <input
              onFocus={(e) => setTimeout(() => e.target.select(), 0)}
              type="number"
              min="0"
              // Bug fix #5: show blank when 0 so first keystroke doesn't
              // produce a leading zero (e.g. "07").
              value={form.vehicle_count === 0 ? "" : form.vehicle_count}
              placeholder="0"
              onChange={(e) => updateField("vehicle_count", e.target.value === "" ? 0 : Math.max(0, parseInt(e.target.value, 10)) || 0)}
              onWheel={(e) => e.target.blur()}
              style={formInputStyle}
            />
          </FormField>
        </div>
      </div>

      {/* HCV block */}
      <div style={{ border: "1.5px solid #14213D", borderRadius: "8px", padding: "18px", marginBottom: "20px" }}>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "0.72rem", color: "#14213D", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "14px" }}>
          HCV Rating inputs
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "12px" }}>
          <FormField label="Asset class">
            <select value={form.asset_class} onChange={(e) => updateField("asset_class", e.target.value)} style={formInputStyle}>
              {Object.keys(HCV_ASSET_CLASS_BASE_RATES).sort((a, b) => a.localeCompare(b)).map((key) => (
                <option key={key} value={key}>{key.replace(/_/g, " ")}</option>
              ))}
            </select>
          </FormField>
          <FormField label="Avg sum insured per vehicle (R)">
            <input
              onFocus={(e) => setTimeout(() => e.target.select(), 0)}
              type="number"
              min="0"
              step="50000"
              // Bug fix #5: show blank when 0 to avoid leading zero on first keystroke
              value={form.avg_sum_insured_per_vehicle === 0 ? "" : form.avg_sum_insured_per_vehicle}
              placeholder="0"
              onChange={(e) => updateField("avg_sum_insured_per_vehicle", e.target.value === "" ? 0 : Math.max(0, Number(e.target.value)) || 0)}
              onWheel={(e) => e.target.blur()}
              style={formInputStyle}
            />
            {/* Bug fix #7: soft warning for implausibly large sum-insured.
                R15m threshold catches the R179m-instead-of-R1.79m class of
                typo without false-positive-ing on legitimate high-value HCV
                (armoured trucks, crane trucks, etc. rarely exceed R10m). */}
            {form.avg_sum_insured_per_vehicle > 15000000 && (
              <div style={{ marginTop: "4px", fontSize: "0.75rem", color: "#B23A2E" }}>
                ⚠ R{(form.avg_sum_insured_per_vehicle / 1000000).toFixed(2)}m per vehicle looks high — did you mean R{(form.avg_sum_insured_per_vehicle / 100).toLocaleString()}?
              </div>
            )}
          </FormField>
          <FormField label="Manufacturer">
            <select value={form.manufacturer} onChange={(e) => updateField("manufacturer", e.target.value)} style={formInputStyle}>
              {Object.keys(HCV_MANUFACTURER_LOADINGS).sort((a, b) => a.localeCompare(b)).map((key) => (
                <option key={key} value={key}>{key.replace(/_/g, " ")}</option>
              ))}
            </select>
          </FormField>
          <FormField label="Average vehicle year model">
            <input
              type="text"
              inputMode="numeric"
              placeholder="e.g. 2015"
              onFocus={(e) => setTimeout(() => e.target.select(), 0)}
              value={form._year_model_raw !== undefined ? form._year_model_raw : (form.year_model || "")}
              onChange={(e) => {
                const raw = e.target.value.replace(/[^0-9]/g, "").slice(0, 4);
                setForm(f => ({ ...f, _year_model_raw: raw }));
                if (raw.length === 4) {
                  const v = parseInt(raw, 10);
                  if (v >= 1980 && v <= 2030) setForm(f => ({ ...f, year_model: v, _year_model_raw: undefined }));
                } else if (raw === "") {
                  setForm(f => ({ ...f, year_model: null, _year_model_raw: undefined }));
                }
              }}
              onBlur={(e) => {
                const raw = e.target.value.replace(/[^0-9]/g, "");
                const v = parseInt(raw, 10);
                if (!isNaN(v) && v >= 1980 && v <= 2030) {
                  setForm(f => ({ ...f, year_model: v, _year_model_raw: undefined }));
                } else {
                  setForm(f => ({ ...f, year_model: null, _year_model_raw: undefined }));
                }
              }}
              onWheel={(e) => e.target.blur()}
              style={formInputStyle} />
          </FormField>
          <FormField label="Avg km / vehicle / month">
            <input
              onFocus={(e) => setTimeout(() => e.target.select(), 0)}
              type="number"
              min="0"
              value={form.avg_km_per_vehicle_month === 0 ? "" : form.avg_km_per_vehicle_month}
              placeholder="0"
              onChange={(e) => updateField("avg_km_per_vehicle_month", e.target.value === "" ? 0 : Math.max(0, parseInt(e.target.value, 10)) || 0)}
              onWheel={(e) => e.target.blur()}
              style={formInputStyle}
            />
          </FormField>
          <FormField label="Primary cargo type (HCV)">
            <select value={form.cargo_type} onChange={(e) => updateField("cargo_type", e.target.value)} style={formInputStyle}>
              {Object.keys(HCV_CARGO_LOADINGS).sort((a, b) => a.localeCompare(b)).map((key) => (
                <option key={key} value={key}>{key.replace(/_/g, " ")}</option>
              ))}
            </select>
          </FormField>
          <FormField label="Primary operating corridor">
            <select value={form.operating_corridor} onChange={(e) => updateField("operating_corridor", e.target.value)} style={formInputStyle}>
              {Object.keys(HCV_CORRIDOR_LOADINGS).sort((a, b) => a.localeCompare(b)).map((key) => (
                <option key={key} value={key}>{key.replace(/_/g, " ")}</option>
              ))}
            </select>
          </FormField>
          <FormField label="Night operations (% distance after 22:00)">
            <input
              onFocus={(e) => setTimeout(() => e.target.select(), 0)} type="number" min="0" max="100" value={Math.round(form.night_ops_pct * 100)} onChange={(e) => updateField("night_ops_pct", Number(e.target.value) / 100)} onWheel={(e) => e.target.blur()} style={formInputStyle} />
          </FormField>
          <FormField label="Anti-theft devices fitted (HCV)">
            <select value={form.anti_theft_devices} onChange={(e) => updateField("anti_theft_devices", e.target.value)} style={formInputStyle}>
              <option value="none">None</option>
              <option value="tracking_only">Tracking only</option>
              <option value="tracking_and_immobiliser">Tracking + immobiliser</option>
            </select>
          </FormField>
          <FormField label="Trend direction (3-month rolling)">
            <select value={form.trend_direction} onChange={(e) => updateField("trend_direction", e.target.value)} style={formInputStyle}>
              <option value="improving_strongly">Improving strongly (-15%)</option>
              <option value="improving_slightly">Improving slightly (-5%)</option>
              <option value="stable">Stable (0%)</option>
              <option value="deteriorating_slightly">Deteriorating slightly (+10%)</option>
              <option value="deteriorating_3plus_months">Deteriorating - 3+ months (+20%)</option>
            </select>
          </FormField>
          <FormField label="Device concealment events/month">
            <input
              onFocus={(e) => setTimeout(() => e.target.select(), 0)} type="number" value={form.device_concealment_events_per_month} onChange={(e) => updateField("device_concealment_events_per_month", Number(e.target.value))} onWheel={(e) => e.target.blur()} style={formInputStyle} />
          </FormField>
          <FormField label="Static questionnaire complete?">
            <select value={form.static_questionnaire_complete ? "yes" : "no"} onChange={(e) => updateField("static_questionnaire_complete", e.target.value === "yes")} style={formInputStyle}>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </FormField>
          <div style={{ gridColumn: "1 / -1" }}>
            <FormField label="HCV telematics data source">
              <select value={form.hcv_data_source || "none"} onChange={(e) => updateField("hcv_data_source", e.target.value)} style={formInputStyle}>
                <option value="none">No telematics — Profile B cap, mandatory conditions (1.40×)</option>
                <option value="oem_only">Fleetboard / OEM only — 61.2% coverage, Profile B cap (1.40×)</option>
                <option value="oem_video">Fleetboard + driver-facing video — 96.2% coverage, Profile A eligible (0.70×)</option>
              </select>
            </FormField>
            {form.hcv_data_source === "none" && (
              <div style={{ fontSize: "0.78rem", color: "#B5762A", marginTop: "4px", lineHeight: 1.5 }}>
                No telematics — fleet capped at Profile B. Mandatory conditions: HoS plan, cellphone warranty, speed limiter verification, 30-day cancellation right. Factor: 1.40× applied in Multi-Cohort pricing.
              </div>
            )}
            {form.hcv_data_source === "oem_only" && (
              <div style={{ fontSize: "0.78rem", color: "#B5762A", marginTop: "4px", lineHeight: 1.5 }}>
                OEM telematics — cellphone usage (15% weight) and safety-belt compliance (10% weight) are data gaps; no camera to see them. Fleet capped at Profile B. Add a driver-facing camera to reach Profile A. Factor: 1.40× applied in Multi-Cohort pricing.
              </div>
            )}
            {form.hcv_data_source === "oem_video" && (
              <div style={{ fontSize: "0.78rem", color: "#2E6B3E", marginTop: "4px", lineHeight: 1.5 }}>
                Full coverage — 96.2% data visibility across all 10 telematics metrics. Profile A eligible. Factor: 0.70× applied in Multi-Cohort pricing.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* GIT block */}
      <div style={{ border: "1.5px solid #14213D", borderRadius: "8px", padding: "18px", marginBottom: "24px" }}>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "0.72rem", color: "#14213D", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "14px" }}>
          GIT Quoting inputs
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "12px", marginBottom: "16px" }}>
          <FormField label="Load limit per vehicle (R)">
            <input
              onFocus={(e) => setTimeout(() => e.target.select(), 0)}
              type="number"
              min="0"
              step="50000"
              value={form.load_limit_per_vehicle === 0 ? "" : form.load_limit_per_vehicle}
              placeholder="0"
              onChange={(e) => {
                const value = e.target.value === "" ? 0 : Math.max(0, parseInt(e.target.value, 10)) || 0;
                setSaved(false);
                setForm((f) => ({
                  ...f,
                  load_limit_per_vehicle: value,
                  // Frans-confirmed R1m RMP-1 threshold -- auto-suggested,
                  // not forced: does not un-tick if the user already
                  // ticked it manually, and can still be unticked by hand.
                  is_rmp1_scoped: value > GIT_RMP1_THRESHOLD_RAND ? true : f.is_rmp1_scoped,
                }));
              }}
              onWheel={(e) => e.target.blur()}
              style={formInputStyle}
            />
          </FormField>
          {form.load_limit_per_vehicle > GIT_RMP1_THRESHOLD_RAND && (
            <div style={{ fontSize: "0.78rem", color: "#B5762A", gridColumn: "1 / -1" }}>
              Load limit exceeds R{GIT_RMP1_THRESHOLD_RAND.toLocaleString()} -- "RMP1-scoped fleet" auto-ticked below (Frans-confirmed threshold). Untick if not applicable.
            </div>
          )}
          <FormField label="Commodity type (GIT)">
            <select value={form.commodity_type} onChange={(e) => updateField("commodity_type", e.target.value)} style={formInputStyle}>
              {GIT_ALL_COMMODITY_OPTIONS.map((key) => (
                <option key={key} value={key}>
                  {key.replace(/_/g, " ")}
                  {GIT_EXCLUDED_COMMODITIES_REQUIRE_REFERRAL.has(key) ? " (referral only)" : ""}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Geographic zone (GIT)">
            <select value={form.geographic_zone} onChange={(e) => updateField("geographic_zone", e.target.value)} style={formInputStyle}>
              <option value="western_cape">Western Cape</option>
              <option value="medium_risk">Medium risk</option>
              <option value="gauteng_high_risk">Gauteng high risk</option>
            </select>
          </FormField>
          <FormField label="Claims history">
            <select value={form.claims_history} onChange={(e) => updateField("claims_history", e.target.value)} style={formInputStyle}>
              <option value="clean">Clean</option>
              <option value="one_claim">One claim</option>
            </select>
          </FormField>
          <FormField label="Loss ratio % (if known)">
            <input
              onFocus={(e) => setTimeout(() => e.target.select(), 0)} type="number" value={form.loss_ratio_pct ?? ""} onChange={(e) => updateField("loss_ratio_pct", e.target.value === "" ? null : Number(e.target.value))} onWheel={(e) => e.target.blur()} placeholder="e.g. 42.5" style={formInputStyle} />
          </FormField>
          <FormField label="Cover type">
            <select value={form.cover_type} onChange={(e) => updateField("cover_type", e.target.value)} style={formInputStyle}>
              <option value="all_risks">All Risks</option>
              <option value="fire_collision_overturning_theft_hijack">Restricted - Fire/Collision/Overturning/Theft-Hijack (80%)</option>
              <option value="fire_collision_overturning_only">Restricted - Fire/Collision/Overturning only (75%)</option>
            </select>
          </FormField>
          <FormField label="Fleet age">
            <select
              value={form.fleet_age || "new"}
              onChange={(e) => { const v = e.target.value; setForm(f => ({ ...f, fleet_age: v })); setSaved(false); }}
              style={formInputStyle}>
              <option value="new">New (under 10 years)</option>
              <option value="over_10yr">Over 10 years</option>
            </select>
          </FormField>
          <FormField label="Night operations">
            <select
              value={form.night_ops || "under_30pct"}
              onChange={(e) => { const v = e.target.value; setForm(f => ({ ...f, night_ops: v })); setSaved(false); }}
              style={formInputStyle}>
              <option value="under_30pct">Under 30% distance after 22:00</option>
              <option value="over_30pct">Over 30% distance after 22:00</option>
            </select>
          </FormField>
          <FormField label="Cross-border">
            <select
              value={form.cross_border || "local"}
              onChange={(e) => { const v = e.target.value; setForm(f => ({ ...f, cross_border: v })); setSaved(false); }}
              style={formInputStyle}>
              <option value="local">Local (RSA only)</option>
              <option value="sadc">SADC cross-border</option>
            </select>
          </FormField>
        </div>

        <div style={{ marginBottom: "16px" }}>
          <SectionLabel>IoT devices fitted (GIT)</SectionLabel>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "6px", marginTop: "10px" }}>
            {Object.keys(GIT_IOT_CREDITS).map((device) => (
              <label key={device} style={checkboxLabelStyle}>
                <input type="checkbox" checked={form.iot_devices_fitted.includes(device)} onChange={() => toggleIotDevice(device)} />
                {device.replace(/_/g, " ")}
              </label>
            ))}
          </div>
        </div>

        <div>
          <SectionLabel>Security &amp; scope (GIT)</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginTop: "10px", marginBottom: "12px" }}>
            <label style={checkboxLabelStyle}>
              <input type="checkbox" checked={form.is_high_value_cargo} onChange={(e) => updateField("is_high_value_cargo", e.target.checked)} />
              High-value cargo
            </label>
            <label style={checkboxLabelStyle}>
              <input type="checkbox" checked={form.is_rmp1_scoped} onChange={(e) => updateField("is_rmp1_scoped", e.target.checked)} />
              RMP1-scoped fleet
            </label>
            <label style={checkboxLabelStyle}>
              <input type="checkbox" checked={form.cargosnap_fitted} onChange={(e) => updateField("cargosnap_fitted", e.target.checked)} />
              Cargosnap fitted
            </label>
          </div>
          <FormField label="Security device fitted (CV+TS+CPI)">
            <select value={form.cvtscpi_rmp_tier} onChange={(e) => updateField("cvtscpi_rmp_tier", e.target.value)} style={formInputStyle}>
              <option value="none">None fitted</option>
              <option value="rmp1_top_lock">RMP1 - Top Lock</option>
              <option value="rmp2_cable_lock">RMP2 - Cable Lock</option>
              <option value="rmp3_tracktag">RMP3 - TrackTag</option>
            </select>
          </FormField>
        </div>
      </div>

      {/* Static risk questionnaire */}
      <div style={{ border: "1.5px solid #14213D", borderRadius: "8px", padding: "18px", marginBottom: "24px" }}>
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "0.72rem", color: "#14213D", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "6px" }}>
          Static Risk Questionnaire (optional — 7 items)
        </div>
        <div style={{ fontSize: "0.78rem", color: "#5C6570", marginBottom: "14px" }}>
          Each item scores 0 / 35 / 70 / 100. Leave "Not scored" to skip — skipped items are excluded from the composite. Scores feed Risk Scoring automatically when you save.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "12px" }}>
          <FormField label="Driving hour policy">
            <select value={form.sq_driving_hour_policy ?? ""} onChange={(e) => updateField("sq_driving_hour_policy", e.target.value === "" ? null : Number(e.target.value))} style={formInputStyle}>
                <option value="">Not scored</option>
                <option value="0">Not in place</option>
                <option value="35">Informal / ad hoc</option>
                <option value="70">Documented policy, some monitoring</option>
                <option value="100">Full policy, enforced & reviewed</option>
            </select>
          </FormField>
          <FormField label="Max speed policy">
            <select value={form.sq_max_speed_policy ?? ""} onChange={(e) => updateField("sq_max_speed_policy", e.target.value === "" ? null : Number(e.target.value))} style={formInputStyle}>
                <option value="">Not scored</option>
                <option value="0">Not in place</option>
                <option value="35">Informal / ad hoc</option>
                <option value="70">Documented policy, some monitoring</option>
                <option value="100">Full policy, enforced & reviewed</option>
            </select>
          </FormField>
          <FormField label="Telematics used for driver management">
            <select value={form.sq_telematics_driver_mgmt ?? ""} onChange={(e) => updateField("sq_telematics_driver_mgmt", e.target.value === "" ? null : Number(e.target.value))} style={formInputStyle}>
                <option value="">Not scored</option>
                <option value="0">Not in place</option>
                <option value="35">Informal / ad hoc</option>
                <option value="70">Documented policy, some monitoring</option>
                <option value="100">Full policy, enforced & reviewed</option>
            </select>
          </FormField>
          <FormField label="Route & distance management">
            <select value={form.sq_route_distance_mgmt ?? ""} onChange={(e) => updateField("sq_route_distance_mgmt", e.target.value === "" ? null : Number(e.target.value))} style={formInputStyle}>
                <option value="">Not scored</option>
                <option value="0">Not in place</option>
                <option value="35">Informal / ad hoc</option>
                <option value="70">Documented policy, some monitoring</option>
                <option value="100">Full policy, enforced & reviewed</option>
            </select>
          </FormField>
          <FormField label="Driver training programme">
            <select value={form.sq_driver_training ?? ""} onChange={(e) => updateField("sq_driver_training", e.target.value === "" ? null : Number(e.target.value))} style={formInputStyle}>
                <option value="">Not scored</option>
                <option value="0">Not in place</option>
                <option value="35">Informal / ad hoc</option>
                <option value="70">Documented policy, some monitoring</option>
                <option value="100">Full policy, enforced & reviewed</option>
            </select>
          </FormField>
          <FormField label="Driver employment process">
            <select value={form.sq_driver_employment ?? ""} onChange={(e) => updateField("sq_driver_employment", e.target.value === "" ? null : Number(e.target.value))} style={formInputStyle}>
                <option value="">Not scored</option>
                <option value="0">Not in place</option>
                <option value="35">Informal / ad hoc</option>
                <option value="70">Documented policy, some monitoring</option>
                <option value="100">Full policy, enforced & reviewed</option>
            </select>
          </FormField>
          <FormField label="Driver remuneration structure">
            <select value={form.sq_driver_remuneration ?? ""} onChange={(e) => updateField("sq_driver_remuneration", e.target.value === "" ? null : Number(e.target.value))} style={formInputStyle}>
                <option value="">Not scored</option>
                <option value="0">Not in place</option>
                <option value="35">Informal / ad hoc</option>
                <option value="70">Documented policy, some monitoring</option>
                <option value="100">Full policy, enforced & reviewed</option>
            </select>
          </FormField>
        </div>
      </div>

      {/* Vehicle Register Table */}
      <div style={{ marginBottom: "20px" }}>
        <SectionLabel>Vehicle Register</SectionLabel>
        <div style={{ fontSize: "0.78rem", color: "#5C6570", marginBottom: "10px" }}>
          Auto-populated from document upload. Add, edit, or remove rows. Each vehicle is priced individually in Multi-Cohort.
        </div>
        {(form.vehicle_register || []).length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.78rem" }}>
              <thead>
                <tr style={{ background: "#14213D", color: "#FAF7F0" }}>
                  {["Type","Reg","Make","Model","Year","Insured Value (R)","Cover",""].map(h => (
                    <th key={h} style={{ padding: "6px 8px", textAlign: "left", whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(form.vehicle_register || []).map((v, i) => (
                  <tr key={i} style={{ background: i % 2 === 0 ? "#fff" : "#F5F7FA" }}>
                    <td style={{ padding: "4px 8px" }}>
                      <select value={v.asset_type || "hcv"} onChange={e => {
                        const reg = [...(form.vehicle_register || [])];
                        reg[i] = { ...reg[i], asset_type: e.target.value };
                        setForm(f => ({ ...f, vehicle_register: reg }));
                      }} style={{ fontSize: "0.75rem", padding: "2px 4px", border: "1px solid #C8D0DC", borderRadius: "3px" }}>
                        <option value="hcv">HCV</option>
                        <option value="trailer">Trailer</option>
                        <option value="ldv">LDV</option>
                        <option value="other">Other</option>
                      </select>
                    </td>
                    {["registration","make","model"].map(field => (
                      <td key={field} style={{ padding: "4px 8px" }}>
                        <input type="text" value={v[field] || ""} onChange={e => {
                          const reg = [...(form.vehicle_register || [])];
                          reg[i] = { ...reg[i], [field]: e.target.value };
                          setForm(f => ({ ...f, vehicle_register: reg }));
                        }} style={{ fontSize: "0.75rem", padding: "2px 4px", border: "1px solid #C8D0DC", borderRadius: "3px", width: field === "model" ? "140px" : "80px" }} />
                      </td>
                    ))}
                    <td style={{ padding: "4px 8px" }}>
                      <input type="text" value={v.year || ""} onChange={e => {
                        const reg = [...(form.vehicle_register || [])];
                        reg[i] = { ...reg[i], year: parseInt(e.target.value) || null };
                        setForm(f => ({ ...f, vehicle_register: reg }));
                      }} style={{ fontSize: "0.75rem", padding: "2px 4px", border: "1px solid #C8D0DC", borderRadius: "3px", width: "50px" }} />
                    </td>
                    <td style={{ padding: "4px 8px" }}>
                      <input type="number" value={v.insured_value || ""} onChange={e => {
                        const reg = [...(form.vehicle_register || [])];
                        reg[i] = { ...reg[i], insured_value: parseInt(e.target.value) || 0 };
                        setForm(f => ({ ...f, vehicle_register: reg }));
                      }} style={{ fontSize: "0.75rem", padding: "2px 4px", border: "1px solid #C8D0DC", borderRadius: "3px", width: "90px" }} />
                    </td>
                    <td style={{ padding: "4px 8px" }}>
                      <select value={v.cover || "comp"} onChange={e => {
                        const reg = [...(form.vehicle_register || [])];
                        reg[i] = { ...reg[i], cover: e.target.value };
                        setForm(f => ({ ...f, vehicle_register: reg }));
                      }} style={{ fontSize: "0.75rem", padding: "2px 4px", border: "1px solid #C8D0DC", borderRadius: "3px" }}>
                        <option value="comp">Comp</option>
                        <option value="specified">Specified</option>
                        <option value="tpl_only">TPL</option>
                      </select>
                    </td>
                    <td style={{ padding: "4px 8px" }}>
                      <button onClick={() => {
                        const reg = (form.vehicle_register || []).filter((_, idx) => idx !== i);
                        setForm(f => ({ ...f, vehicle_register: reg }));
                      }} style={{ background: "transparent", border: "none", color: "#C0392B", cursor: "pointer", fontSize: "0.85rem", fontWeight: 700 }}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: "#E8EDF5", fontWeight: 600 }}>
                  <td colSpan={5} style={{ padding: "6px 8px", fontSize: "0.78rem" }}>
                    {(form.vehicle_register || []).filter(v => v.asset_type === "hcv").length} HCV trucks · {(form.vehicle_register || []).filter(v => v.asset_type === "trailer").length} trailers
                  </td>
                  <td style={{ padding: "6px 8px", fontSize: "0.78rem" }}>
                    R{(form.vehicle_register || []).reduce((s, v) => s + (v.insured_value || 0), 0).toLocaleString("en-ZA")}
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <div style={{ padding: "12px", background: "#F5F7FA", borderRadius: "6px", fontSize: "0.82rem", color: "#5C6570", textAlign: "center" }}>
            No vehicles yet — upload a fleet schedule or add rows manually.
          </div>
        )}
        <button
          onClick={() => {
            const reg = [...(form.vehicle_register || []), { registration: "", make: "", model: "", year: null, insured_value: 0, cover: "comp", asset_type: "hcv" }];
            setForm(f => ({ ...f, vehicle_register: reg }));
          }}
          style={{ marginTop: "8px", background: "transparent", border: "1px solid #14213D", color: "#14213D", borderRadius: "5px", padding: "5px 14px", fontSize: "0.80rem", cursor: "pointer" }}>
          + Add vehicle
        </button>
      </div>

      <button
        className="tx-btn"
        onClick={handleSave}
        style={{
          background: "#14213D",
          color: "#FAF7F0",
          border: "none",
          borderRadius: "5px",
          padding: "10px 20px",
          fontSize: "0.9rem",
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: "'Inter', sans-serif",
        }}
      >
        Save fleet information
      </button>
      {saved && (
        <div style={{ marginTop: "12px", fontSize: "0.82rem", color: "#3D6B4F" }}>
          Saved — fleet details and questionnaire scores carried through to Risk Scoring and Multi-Cohort.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `You are a data extraction tool. You will be shown a PDF that is one of two document types used by a South African HCV/GIT insurance underwriter:

CRITICAL PRIVACY RULE: Never extract, repeat, or reference any personal identifying information — this includes ID numbers, passport numbers, dates of birth, banking details, or any government-issued identifier, even if visible in the document. This applies regardless of how clearly the document displays such numbers.

TYPE A: An RMS/LibroAssist "Transporter Risk Report" — a telematics/i-Cab risk report with monthly graphs and tables of driver behaviour scores.
TYPE B: An insurer policy schedule with GIT cover limits, premiums, and vehicle lists.

Extract ONLY what is explicitly stated in the document. Do not infer, average, or estimate any number that is not directly printed or clearly readable from a labelled data table. If a value is only visible on a graph without an accompanying printed number, set it to null and note it in "low_confidence_fields" rather than guessing.

CRITICAL: Never place a raw incident count into a "_score" field, or vice versa. If a page only shows a 0-100 risk score with no exact number, the score field is null. If a page separately shows a raw count table, use the matching "_count" field instead. These are never interchangeable.

CRITICAL FOR POLICY SCHEDULES: These documents often contain MULTIPLE candidate numbers for what looks like the same field (e.g. a GIT-section premium subtotal AND a whole-policy total premium; a GIT-covered vehicle count AND a full motor asset register count including trailers). Never collapse these into one ambiguous field. Always populate BOTH the GIT-specific figure and the whole-policy total figure separately, clearly labelled, so nothing is lost or guessed at.

Return ONLY valid JSON (no markdown fences, no prose) in this exact shape:
{
  "document_type": "RMS_REPORT" or "POLICY_SCHEDULE",
  "transporter_or_insured_name": string,
  "report_or_schedule_date": string,
  "period_reviewed": string or null,
  "fleet_summary": {
    "avg_vehicles": number or null,
    "avg_km_per_vehicle_month": number or null,
    "combined_risk_score_latest": number or null
  },
  "monthly_data": [
    {
      "month": "YYYY-MM",
      "combined_score_reported": number or null,
      "distance_index": number or null,
      "speeding": number or null,
      "fatigue_hos": number or null,
      "device_covered_count": number or null
    }
  ],
  "static_risk": { "score": number or null, "note": string or null },
  "policy_details": {
    "insurer": string or null,
    "policy_number": string or null,
    "git_limit_per_vehicle": number or null,
    "git_section_vehicle_count": number or null,
    "git_section_premium": number or null,
    "total_policy_vehicle_count": number or null,
    "total_policy_premium": number or null,
    "pvpm_rate": number or null
  },
  "low_confidence_fields": [string],
  "extraction_notes": string
}`;

const VERDICT_STYLES = {
  ACCEPT: { ink: "#3D6B4F", label: "ACCEPT" },
  DECLINE: { ink: "#B23A2E", label: "DECLINE" },
  REFER: { ink: "#B5762A", label: "REFER" },
  "CONDITIONAL ACCEPT": { ink: "#B5762A", label: "CONDITIONAL ACCEPT" },
  "INSUFFICIENT DATA": { ink: "#5C6570", label: "INSUFFICIENT DATA" },
  QUOTABLE: { ink: "#3D6B4F", label: "QUOTABLE" },
  "CANNOT BIND": { ink: "#B23A2E", label: "CANNOT BIND" },
};

function StampBadge({ verdict }) {
  const style = VERDICT_STYLES[verdict] || VERDICT_STYLES["INSUFFICIENT DATA"];
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        border: `4px solid ${style.ink}`,
        color: style.ink,
        borderRadius: "6px",
        padding: "14px 28px",
        transform: "rotate(-3deg)",
        fontFamily: "'IBM Plex Mono', monospace",
        fontWeight: 700,
        fontSize: "1.5rem",
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        boxShadow: `inset 0 0 0 1px ${style.ink}`,
        background: "rgba(255,255,255,0.4)",
      }}
    >
      {style.label}
    </div>
  );
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// RiskScoringView — Stage 2: standalone score view (no premium shown here)
// ─────────────────────────────────────────────────────────────────────────────
function RiskScoringView({ sharedFleetInfo, onProceedToPricing }) {
  const defaults = {
    fatigue_hos: 0, speeding: 0, cellphone_usage: 0,
    safety_belt_compliance: 0, driver_behaviour_composite: 0,
    distance_index: 0, device_integrity: 0,
    time_on_road: 0, night_driving_ratio: 0,
    device_concealment_events_per_month: 0,
    avg_km_per_vehicle_month: 0,
    trend: "stable",
    static_q1: "", static_q2: "", static_q3: "",
    static_q4: "", static_q5: "", static_q6: "", static_q7: "",
    data_source: "oem_only",
  };

  const [f, setF] = React.useState(() => {
    if (!sharedFleetInfo) return defaults;
    return { ...defaults, ...sharedFleetInfo };
  });
  const [scored, setScored] = React.useState(null);

  const update = (k, v) => setF(prev => ({ ...prev, [k]: v }));

  const numInput = (label, key, max = 100) => (
    <div style={{ marginBottom: "10px" }}>
      <label style={{ display: "block", fontSize: "0.82rem", fontWeight: 600, color: "#14213D", marginBottom: "3px" }}>{label}</label>
      <input type="number" min={0} max={max} value={f[key]}
        onFocus={e => setTimeout(() => e.target.select(), 0)}
        onChange={e => update(key, Math.min(max, Math.max(0, Number(e.target.value))))}
        style={{ width: "100%", padding: "7px 10px", border: "1px solid #C8D0DC", borderRadius: "5px", fontSize: "0.9rem", boxSizing: "border-box" }} />
    </div>
  );

  const STATIC_LABELS = [
    "1. Driving Hour Policy (formalised, enforced)",
    "2. Maximum Speed Policy (written, monitored)",
    "3. Telematics Used for Driver Management",
    "4. Route / Distance Management",
    "5. Driver Training Programme",
    "6. Driver Employment Process (screening)",
    "7. Driver Remuneration (incentive-aligned)",
  ];
  const STATIC_OPTS = [
    { value: "", label: "Not scored" },
    { value: "0",  label: "0 — Not in place" },
    { value: "35", label: "35 — Informal / partial" },
    { value: "70", label: "70 — Documented, inconsistently applied" },
    { value: "100", label: "100 — Fully implemented, actively monitored" },
  ];

  function computeScore() {
    const w = {
      fatigue_hos: 0.20, speeding: 0.15, cellphone_usage: 0.15,
      safety_belt_compliance: 0.10, driver_behaviour_composite: 0.10,
      distance_index: 0.08, device_integrity: 0.07,
      time_on_road: 0.03, night_driving_ratio: 0.02,
    };
    let weighted = 0;
    Object.entries(w).forEach(([k, wt]) => { weighted += (f[k] || 0) * wt; });

    // Concealment addition
    const conc = f.device_concealment_events_per_month || 0;
    const concAdd = conc > 200 ? 30 : conc > 100 ? 15 : 0;

    // Trend
    const trendMap = { improving_strongly: -0.15, improving_slightly: -0.05, stable: 0, deteriorating_slightly: 0.10, deteriorating_3plus_months: 0.20 };
    const trendAdd = weighted * (trendMap[f.trend] || 0);

    // Static questionnaire
    const staticVals = [f.static_q1,f.static_q2,f.static_q3,f.static_q4,f.static_q5,f.static_q6,f.static_q7]
      .filter(v => v !== "" && v != null).map(Number);
    const staticScore = staticVals.length > 0 ? staticVals.reduce((a,b) => a+b, 0) / staticVals.length : null;
    const questPenalty = staticScore != null ? 0 : 0; // blended below

    let combined;
    if (staticScore != null) {
      combined = (weighted * 0.90) + (staticScore * 0.10) + concAdd + trendAdd;
    } else {
      combined = weighted + concAdd + trendAdd;
    }

    // Auto-decline checks
    const declines = [];
    if (combined > 100) declines.push("Combined score > 100");
    if ((f.avg_km_per_vehicle_month || 0) > 16000) declines.push("Avg km/vehicle/month > 16,000 (illegal HoS)");
    if (conc > 200) declines.push("Device concealment > 200 events/month");
    if ((f.speeding || 0) > 60 && (f.fatigue_hos || 0) > 80) declines.push("Speeding > 60 AND Fatigue > 80 simultaneously");

    // Profile
    let profile, factor;
    if (declines.length > 0) {
      profile = "DECLINE"; factor = null;
    } else if (combined <= 25) {
      profile = "Profile A"; factor = 0.70;
    } else if (combined <= 45) {
      profile = "Profile A"; factor = 0.95;
    } else if (combined <= 65) {
      profile = "Profile B — Conditional Accept"; factor = 1.40;
    } else if (combined <= 85) {
      profile = "Profile C — Decline"; factor = 1.90;
    } else {
      profile = "Profile C — Decline"; factor = 2.50;
    }

    // Data-source cap
    let capNote = null;
    if (profile === "Profile A" && f.data_source !== "oem_video") {
      capNote = `Profile A capped to Profile B — data source "${f.data_source}" does not provide 96.2% behavioural coverage. Fleetboard + driver-facing video required for Profile A.`;
      profile = "Profile B — Conditional Accept (capped)"; factor = 1.40;
    }

    return { combined: combined.toFixed(1), weighted: weighted.toFixed(1), staticScore: staticScore != null ? staticScore.toFixed(1) : "Not scored", concAdd, trendAdd: trendAdd.toFixed(1), profile, factor, declines, capNote };
  }

  const cardStyle = { background: "#fff", border: "1px solid #E0E6EE", borderRadius: "8px", padding: "20px", marginBottom: "16px" };
  const sectionLabel = { fontSize: "0.78rem", fontWeight: 700, color: "#B5762A", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "12px" };

  return (
    <div style={{ maxWidth: "860px", margin: "0 auto" }}>
      <div style={{ background: "#E8EDF5", borderRadius: "8px", padding: "14px 18px", marginBottom: "20px", fontSize: "0.88rem", color: "#14213D" }}>
        <strong>Stage 2 — Risk Scoring.</strong> Enter telematics scores and static questionnaire. Click <em>Compute Risk Score</em> to see the Profile verdict. No premium is calculated here — proceed to Stage 3 for pricing.
        {sharedFleetInfo?.fleet_name && <span style={{ marginLeft: "12px", color: "#5C6570" }}>Fleet: <strong>{sharedFleetInfo.fleet_name}</strong></span>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
        <div style={cardStyle}>
          <div style={sectionLabel}>Telematics Behavioural Scores (0 – 100)</div>
          {numInput("Fatigue / HOS (weight 20%)", "fatigue_hos")}
          {numInput("Speeding (weight 15%)", "speeding")}
          {numInput("Cellphone Usage (weight 15%)", "cellphone_usage")}
          {numInput("Safety Belt Compliance (weight 10%)", "safety_belt_compliance")}
          {numInput("Driver Behaviour Composite (weight 10%)", "driver_behaviour_composite")}
          {numInput("Distance Index (weight 8%)", "distance_index")}
          {numInput("Device Integrity (weight 7%)", "device_integrity")}
          {numInput("Time on Road (weight 3%)", "time_on_road")}
          {numInput("Night Driving Ratio (weight 2%)", "night_driving_ratio")}
        </div>

        <div>
          <div style={cardStyle}>
            <div style={sectionLabel}>Modifiers</div>
            {numInput("Device Concealment Events / month", "device_concealment_events_per_month", 9999)}
            {numInput("Avg km / vehicle / month", "avg_km_per_vehicle_month", 99999)}
            <div style={{ marginBottom: "10px" }}>
              <label style={{ display: "block", fontSize: "0.82rem", fontWeight: 600, color: "#14213D", marginBottom: "3px" }}>Trend</label>
              <select value={f.trend} onChange={e => update("trend", e.target.value)}
                style={{ width: "100%", padding: "7px 10px", border: "1px solid #C8D0DC", borderRadius: "5px", fontSize: "0.9rem" }}>
                <option value="improving_strongly">Improving strongly (−15%)</option>
                <option value="improving_slightly">Improving slightly (−5%)</option>
                <option value="stable">Stable (0%)</option>
                <option value="deteriorating_slightly">Deteriorating slightly (+10%)</option>
                <option value="deteriorating_3plus_months">Deteriorating 3+ months (+20%)</option>
              </select>
            </div>
            <div style={{ marginBottom: "10px" }}>
              <label style={{ display: "block", fontSize: "0.82rem", fontWeight: 600, color: "#14213D", marginBottom: "3px" }}>Data Source (qualifier)</label>
              <select value={f.data_source} onChange={e => update("data_source", e.target.value)}
                style={{ width: "100%", padding: "7px 10px", border: "1px solid #C8D0DC", borderRadius: "5px", fontSize: "0.9rem" }}>
                <option value="none">No telematics — Profile B cap (1.40×)</option>
                <option value="oem_only">Fleetboard / OEM only — 61.2% coverage, Profile B cap (1.40×)</option>
                <option value="oem_video">Fleetboard + driver-facing video — 96.2% coverage, Profile A eligible (0.70×)</option>
              </select>
            </div>
          </div>

          <div style={cardStyle}>
            <div style={sectionLabel}>Static Questionnaire (7 items, 10% weight)</div>
            {STATIC_LABELS.map((lbl, i) => {
              const key = `static_q${i+1}`;
              return (
                <div key={key} style={{ marginBottom: "8px" }}>
                  <label style={{ display: "block", fontSize: "0.80rem", color: "#14213D", marginBottom: "2px" }}>{lbl}</label>
                  <select value={f[key]} onChange={e => update(key, e.target.value)}
                    style={{ width: "100%", padding: "6px 8px", border: "1px solid #C8D0DC", borderRadius: "5px", fontSize: "0.85rem" }}>
                    {STATIC_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div style={{ textAlign: "center", margin: "20px 0" }}>
        <button className="tx-btn"
          style={{ background: "#14213D", color: "#FAF7F0", padding: "12px 36px", fontSize: "1rem", fontWeight: 700, borderRadius: "6px", border: "none", cursor: "pointer", marginRight: "12px" }}
          onClick={() => setScored(computeScore())}>
          Compute Risk Score
        </button>
      </div>

      {scored && (
        <div style={{ ...cardStyle, border: `2px solid ${scored.declines.length > 0 ? "#C0392B" : scored.profile.includes("Profile A") ? "#1A6B3C" : "#B5762A"}`, marginTop: "8px" }}>
          <div style={{ fontSize: "1.1rem", fontWeight: 700, marginBottom: "12px", color: scored.declines.length > 0 ? "#C0392B" : scored.profile.includes("Profile A") ? "#1A6B3C" : "#B5762A" }}>
            {scored.declines.length > 0 ? "⛔ AUTO-DECLINE" : scored.profile.includes("Profile A") ? "✅ " + scored.profile : "⚠️ " + scored.profile}
          </div>
          {scored.declines.length > 0 && scored.declines.map((d,i) => (
            <div key={i} style={{ color: "#C0392B", fontSize: "0.9rem", marginBottom: "4px" }}>• {d}</div>
          ))}
          {scored.capNote && <div style={{ color: "#B5762A", fontSize: "0.88rem", marginBottom: "10px", fontStyle: "italic" }}>⚠️ {scored.capNote}</div>}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "12px", marginTop: "12px" }}>
            {[
              ["Combined Score", scored.combined],
              ["Weighted Telematics", scored.weighted],
              ["Static Score", scored.staticScore],
              ["Concealment Addition", `+${scored.concAdd}`],
              ["Trend Addition", scored.trendAdd],
              ["Rating Factor", scored.factor != null ? `${scored.factor}×` : "N/A"],
            ].map(([lbl, val]) => (
              <div key={lbl} style={{ background: "#F5F7FA", borderRadius: "6px", padding: "10px 14px" }}>
                <div style={{ fontSize: "0.75rem", color: "#5C6570", marginBottom: "2px" }}>{lbl}</div>
                <div style={{ fontWeight: 700, fontSize: "1.1rem", color: "#14213D" }}>{val}</div>
              </div>
            ))}
          </div>
          {scored.declines.length === 0 && (
            <div style={{ textAlign: "center", marginTop: "20px" }}>
              <button className="tx-btn"
                style={{ background: "#B5762A", color: "#fff", padding: "10px 32px", fontSize: "0.95rem", fontWeight: 700, borderRadius: "6px", border: "none", cursor: "pointer" }}
                onClick={onProceedToPricing}>
                Proceed to Pricing →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function TelematixRater() {
  const [status, setStatus] = useState("idle"); // idle | reading | extracting | done | error
  const [mode, setMode] = useState("fleet_info"); // hcv | hcv_rating | git | fleet_info | multi_cohort | risk_scoring
  const [riskScoreResult, setRiskScoreResult] = useState(null);
  const [sharedFleetInfo, setSharedFleetInfo] = useState(null);
  const [fileName, setFileName] = useState(null);
  const [extracted, setExtracted] = useState(null);
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const inputRef = useRef(null);

  const processFile = useCallback(async (file) => {
    if (!file || !(file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"))) {
      setStatus("error");
      setErrorMsg("Please provide a PDF file — that's the only format this reads.");
      return;
    }
    setFileName(file.name);
    setStatus("reading");
    setExtracted(null);
    setResult(null);
    setErrorMsg(null);

    try {
      const b64 = await fileToBase64(file);
      setStatus("extracting");

      const response = await fetch("https://telematix-rater-backend.onrender.com/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 8000,
          messages: [
            {
              role: "user",
              content: [
                { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
                { type: "text", text: EXTRACTION_PROMPT },
              ],
            },
          ],
        }),
      });

      const data = await response.json();
      let rawText = (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      rawText = rawText.trim();
      if (rawText.startsWith("```")) {
        rawText = rawText.replace(/^```(json)?/, "").replace(/```$/, "").trim();
      }

      const json = JSON.parse(rawText);
      setExtracted(json);

      if (json.document_type === "POLICY_SCHEDULE") {
        setResult({ policySchedule: true });
      } else {
        setResult(scoreFleet(json));
      }
      setStatus("done");
    } catch (err) {
      setStatus("error");
      setErrorMsg(err.message || "Extraction failed. Try again, or try a smaller/clearer PDF.");
    }
  }, []);

  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      processFile(file);
    },
    [processFile]
  );

  const reset = () => {
    setStatus("idle");
    setFileName(null);
    setExtracted(null);
    setResult(null);
    setErrorMsg(null);
    setShowRaw(false);
  };

  return (
    <div
      style={{
        fontFamily: "'Inter', -apple-system, sans-serif",
        background: "#FAF7F0",
        color: "#14213D",
        minHeight: "100%",
        padding: "0",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@500;700&family=Fraunces:wght@600;700&display=swap');
        .tx-root * { box-sizing: border-box; }
        .tx-upload-zone:focus-visible { outline: 2px solid #14213D; outline-offset: 3px; }
        .tx-btn:focus-visible { outline: 2px solid #14213D; outline-offset: 2px; }
        @media (prefers-reduced-motion: reduce) {
          .tx-root * { transition: none !important; animation: none !important; }
        }
      `}</style>

      <div className="tx-root" style={{ maxWidth: "760px", margin: "0 auto", padding: "40px 24px 64px" }}>
        {/* Header */}
        <div style={{ marginBottom: "36px", borderBottom: "2px solid #14213D", paddingBottom: "20px" }}>
          <div
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: "0.75rem",
              letterSpacing: "0.15em",
              color: "#B5762A",
              textTransform: "uppercase",
              marginBottom: "6px",
            }}
          >
            TelematiX — Stream 2 Virtual Underwriter
          </div>
          <h1
            style={{
              fontFamily: "'Fraunces', serif",
              fontSize: "1.9rem",
              fontWeight: 700,
              margin: 0,
              lineHeight: 1.15,
            }}
          >
            TelematiX — Stream 2 Virtual Underwriter
          </h1>
          {/* pipeline-v3 */}
          <p style={{ color: "#5C6570", fontSize: "0.95rem", marginTop: "8px", marginBottom: 0 }}>
            One pipeline: Intake → Risk Scoring → Pricing, branching by asset class. Capture fleet details once in Fleet Information to carry through every step. Extraction and scoring always run separately — the rating is never guessed by the model.
          </p>
        </div>

        {/* ── 3-Stage pipeline progress bar ── */}
        <div style={{ display: "flex", alignItems: "center", marginBottom: "20px", borderRadius: "6px", overflow: "hidden", border: "1px solid #C8D0DC" }}>
          <div
            onClick={() => setMode("fleet_info")}
            style={{
              flex: 1, padding: "11px 14px", textAlign: "center", cursor: "pointer",
              background: (mode === "fleet_info" || mode === "hcv") ? "#14213D" : "#E8EDF5",
              color: (mode === "fleet_info" || mode === "hcv") ? "#FAF7F0" : "#5C6570",
              fontWeight: (mode === "fleet_info" || mode === "hcv") ? 700 : 500,
              fontSize: "0.88rem", borderRight: "1px solid #C8D0DC",
            }}
          >
            1 · Intake
          </div>
          <div
            onClick={() => setMode("risk_scoring")}
            style={{
              flex: 1, padding: "11px 14px", textAlign: "center", cursor: "pointer",
              background: mode === "risk_scoring" ? "#14213D" : "#E8EDF5",
              color: mode === "risk_scoring" ? "#FAF7F0" : "#5C6570",
              fontWeight: mode === "risk_scoring" ? 700 : 500,
              fontSize: "0.88rem", borderRight: "1px solid #C8D0DC",
            }}
          >
            2 · Risk Scoring
          </div>
          <div
            onClick={() => setMode("multi_cohort")}
            style={{
              flex: 1, padding: "11px 14px", textAlign: "center", cursor: "pointer",
              background: (mode === "multi_cohort" || mode === "hcv_rating" || mode === "git") ? "#14213D" : "#E8EDF5",
              color: (mode === "multi_cohort" || mode === "hcv_rating" || mode === "git") ? "#FAF7F0" : "#5C6570",
              fontWeight: (mode === "multi_cohort" || mode === "hcv_rating" || mode === "git") ? 700 : 500,
              fontSize: "0.88rem",
            }}
          >
            3 · Pricing
          </div>
        </div>

        {/* ── Sub-tool row per stage ── */}
        <div style={{ display: "flex", gap: "8px", marginBottom: "28px", flexWrap: "wrap" }}>
          {(mode === "fleet_info" || mode === "hcv") && (
            <>
              <button className="tx-btn" onClick={() => setMode("fleet_info")}
                style={{ ...tabBtnStyle, background: mode === "fleet_info" ? "#14213D" : "transparent", color: mode === "fleet_info" ? "#FAF7F0" : "#14213D" }}>
                Fleet Information
              </button>
              <button className="tx-btn" onClick={() => setMode("hcv")}
                style={{ ...tabBtnStyle, background: mode === "hcv" ? "#14213D" : "transparent", color: mode === "hcv" ? "#FAF7F0" : "#14213D" }}>
                Analyse Existing Policy
              </button>
            </>
          )}
          {mode === "risk_scoring" && (
            <button className="tx-btn" onClick={() => setMode("risk_scoring")}
              style={{ ...tabBtnStyle, background: "#14213D", color: "#FAF7F0" }}>
              HCV Risk Score
            </button>
          )}
          {(mode === "multi_cohort" || mode === "hcv_rating" || mode === "git") && (
            <>
              <button className="tx-btn" onClick={() => setMode("multi_cohort")}
                style={{ ...tabBtnStyle, background: mode === "multi_cohort" ? "#14213D" : "transparent", color: mode === "multi_cohort" ? "#FAF7F0" : "#14213D" }}>
                Multi-Cohort
              </button>
              <button className="tx-btn" onClick={() => setMode("hcv_rating")}
                style={{ ...tabBtnStyle, background: mode === "hcv_rating" ? "#14213D" : "transparent", color: mode === "hcv_rating" ? "#FAF7F0" : "#14213D" }}>
                HCV Rating
              </button>
              <button className="tx-btn" onClick={() => setMode("git")}
                style={{ ...tabBtnStyle, background: mode === "git" ? "#14213D" : "transparent", color: mode === "git" ? "#FAF7F0" : "#14213D" }}>
                GIT Quoting
              </button>
            </>
          )}
        </div>

        {mode === "risk_scoring" ? (
          <RiskScoringView sharedFleetInfo={sharedFleetInfo} onProceedToPricing={() => setMode("multi_cohort")} />
        ) : mode === "multi_cohort" ? (
          <MultiCohortView sharedFleetInfo={sharedFleetInfo} />
        ) : mode === "git" ? (
          <GitQuotingView sharedFleetInfo={sharedFleetInfo} />
        ) : mode === "hcv_rating" ? (
          <HcvRatingView sharedFleetInfo={sharedFleetInfo} />
        ) : mode === "fleet_info" ? (
          <FleetInformationView sharedFleetInfo={sharedFleetInfo} onSave={(info) => { setSharedFleetInfo(info); setMode("risk_scoring"); }} />
        ) : (
          <>
        {/* Upload zone */}
        {status === "idle" || status === "error" ? (
          <div
            className="tx-upload-zone"
            role="button"
            tabIndex={0}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            style={{
              border: `2px dashed ${dragOver ? "#B5762A" : "#14213D"}`,
              borderRadius: "8px",
              padding: "56px 24px",
              textAlign: "center",
              cursor: "pointer",
              background: dragOver ? "rgba(181,118,42,0.06)" : "transparent",
              transition: "all 0.15s ease",
            }}
          >
            <div style={{ fontSize: "2rem", marginBottom: "10px" }}>📄</div>
            <div style={{ fontWeight: 600, fontSize: "1.05rem" }}>
              Drop a PDF here, or click to choose one
            </div>
            <div style={{ color: "#5C6570", fontSize: "0.85rem", marginTop: "6px" }}>
              RMS transporter risk report or insurer GIT policy schedule
            </div>
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf"
              style={{ display: "none" }}
              onChange={(e) => processFile(e.target.files?.[0])}
            />
            {status === "error" && (
              <div
                style={{
                  marginTop: "20px",
                  color: "#B23A2E",
                  fontSize: "0.9rem",
                  fontFamily: "'IBM Plex Mono', monospace",
                }}
              >
                {errorMsg}
              </div>
            )}
          </div>
        ) : null}

        {/* Loading state */}
        {(status === "reading" || status === "extracting") && (
          <div style={{ textAlign: "center", padding: "48px 0" }}>
            <div
              style={{
                width: "36px",
                height: "36px",
                margin: "0 auto 18px",
                border: "3px solid #E4DCC9",
                borderTopColor: "#B5762A",
                borderRadius: "50%",
                animation: "spin 0.8s linear infinite",
              }}
            />
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "0.85rem", color: "#5C6570" }}>
              {status === "reading" ? "Reading " + fileName : "Extracting from document — this can take a minute on long schedules..."}
            </div>
          </div>
        )}

        {/* Results */}
        {status === "done" && result && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "24px" }}>
              <div>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "0.75rem", color: "#5C6570", marginBottom: "4px" }}>
                  {fileName}
                </div>
                <div style={{ fontSize: "1.1rem", fontWeight: 600 }}>
                  {extracted?.transporter_or_insured_name || "Unknown"}
                </div>
              </div>
              <button className="tx-btn" onClick={reset} style={resetBtnStyle}>
                Rate another
              </button>
            </div>

            {result.policySchedule ? (
              <PolicyScheduleView extracted={extracted} />
            ) : (
              <FleetVerdictView extracted={extracted} result={result} />
            )}

            <button
              className="tx-btn"
              onClick={() => setShowRaw((s) => !s)}
              style={{ ...resetBtnStyle, marginTop: "28px", fontSize: "0.8rem" }}
            >
              {showRaw ? "Hide raw extraction JSON" : "Show raw extraction JSON"}
            </button>
            {showRaw && (
              <pre
                style={{
                  marginTop: "12px",
                  background: "#14213D",
                  color: "#E4DCC9",
                  padding: "16px",
                  borderRadius: "6px",
                  fontSize: "0.72rem",
                  overflowX: "auto",
                  fontFamily: "'IBM Plex Mono', monospace",
                }}
              >
                {JSON.stringify(extracted, null, 2)}
              </pre>
            )}
          </div>
        )}
          </>
        )}
      </div>
    </div>
  );
}

const tabBtnStyle = {
  border: "1.5px solid #14213D",
  borderRadius: "5px",
  padding: "8px 16px",
  fontSize: "0.85rem",
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "'Inter', sans-serif",
};

function GitQuotingView({ sharedFleetInfo }) {
  const [form, setForm] = useState(() =>
    makeGitFleetInput(
      sharedFleetInfo
        ? {
            fleet_name: sharedFleetInfo.fleet_name,
            vehicle_count: sharedFleetInfo.vehicle_count,
            load_limit_per_vehicle: sharedFleetInfo.load_limit_per_vehicle,
            commodity_type: sharedFleetInfo.commodity_type,
            geographic_zone: sharedFleetInfo.geographic_zone,
            claims_history: sharedFleetInfo.claims_history,
            loss_ratio_pct: sharedFleetInfo.loss_ratio_pct,
            cover_type: sharedFleetInfo.cover_type,
            iot_devices_fitted: sharedFleetInfo.iot_devices_fitted,
            cargosnap_fitted: sharedFleetInfo.cargosnap_fitted,
            cvtscpi_rmp_tier: sharedFleetInfo.cvtscpi_rmp_tier,
            is_high_value_cargo: sharedFleetInfo.is_high_value_cargo,
            is_rmp1_scoped: sharedFleetInfo.is_rmp1_scoped,
          }
        : {}
    )
  );
  const [selected, setSelected] = useState(null);
  const [result, setResult] = useState(null);
  const [overrideApproverName, setOverrideApproverName] = useState("");
  const [overrideReasonText, setOverrideReasonText] = useState("");
  const [manualFactorInput, setManualFactorInput] = useState("");

  const updateField = (key, value) => {
    setSelected(null);
    setForm((f) => ({ ...f, [key]: value }));
  };

  const toggleIotDevice = (device) => {
    setSelected(null);
    setForm((f) => {
      const has = f.iot_devices_fitted.includes(device);
      return {
        ...f,
        iot_devices_fitted: has
          ? f.iot_devices_fitted.filter((d) => d !== device)
          : [...f.iot_devices_fitted, device],
      };
    });
  };

  const computeQuote = () => {
    setOverrideApproverName("");
    setOverrideReasonText("");
    setManualFactorInput("");
    setResult(computeGitPvpm(form));
  };

  const isExcludedCommodity = GIT_EXCLUDED_COMMODITIES_REQUIRE_REFERRAL.has(form.commodity_type);
  const overrideReady =
    overrideApproverName.trim() !== "" &&
    overrideReasonText.trim() !== "" &&
    (!isExcludedCommodity || manualFactorInput !== "");

  const applyOverride = () => {
    const factorNum = manualFactorInput === "" ? null : Number(manualFactorInput);
    const formWithFactor = { ...form, manual_commodity_factor: factorNum };
    setResult(computeGitPvpm(formWithFactor, { approverName: overrideApproverName.trim(), reason: overrideReasonText.trim() }));
  };

  return (
    <div>
      <div
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: "0.75rem",
          color: "#B5762A",
          marginBottom: "16px",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        GIT Quoting
      </div>

      <div style={{ marginBottom: "20px" }}>
        <SectionLabel>Fleet details</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "12px", marginTop: "12px" }}>
          <FormField label="Fleet name">
            <input
              type="text"
              value={form.fleet_name}
              onChange={(e) => updateField("fleet_name", e.target.value)}
              style={formInputStyle}
            />
          </FormField>
          <FormField label="Vehicle count">
            <input
              onFocus={(e) => setTimeout(() => e.target.select(), 0)}
              type="number"
              value={form.vehicle_count}
              onChange={(e) => updateField("vehicle_count", Number(e.target.value))}
              onWheel={(e) => e.target.blur()}
              style={formInputStyle}
            />
          </FormField>
          <FormField label="Load limit per vehicle (R)">
            <input
              onFocus={(e) => setTimeout(() => e.target.select(), 0)}
              type="number"
              value={form.load_limit_per_vehicle}
              onChange={(e) => updateField("load_limit_per_vehicle", Number(e.target.value))}
              onWheel={(e) => e.target.blur()}
              step="50000"
              style={formInputStyle}
            />
          </FormField>
          <FormField label="Commodity type">
            <select
              value={form.commodity_type}
              onChange={(e) => updateField("commodity_type", e.target.value)}
              style={formInputStyle}
            >
              {GIT_ALL_COMMODITY_OPTIONS.map((key) => (
                <option key={key} value={key}>
                  {key.replace(/_/g, " ")}
                  {GIT_EXCLUDED_COMMODITIES_REQUIRE_REFERRAL.has(key) ? " (referral only)" : ""}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Geographic zone">
            <select
              value={form.geographic_zone}
              onChange={(e) => updateField("geographic_zone", e.target.value)}
              style={formInputStyle}
            >
              <option value="western_cape">Western Cape</option>
              <option value="medium_risk">Medium risk</option>
              <option value="gauteng_high_risk">Gauteng high risk</option>
            </select>
          </FormField>
          <FormField label="Claims history">
            <select
              value={form.claims_history}
              onChange={(e) => updateField("claims_history", e.target.value)}
              style={formInputStyle}
            >
              <option value="clean">Clean</option>
              <option value="one_claim">One claim</option>
            </select>
          </FormField>
          <FormField label="Loss ratio % (if known)">
            <input
              onFocus={(e) => setTimeout(() => e.target.select(), 0)}
              type="number"
              value={form.loss_ratio_pct ?? ""}
              onChange={(e) => updateField("loss_ratio_pct", e.target.value === "" ? null : Number(e.target.value))}
              onWheel={(e) => e.target.blur()}
              placeholder="e.g. 42.5"
              style={formInputStyle}
            />
          </FormField>
          <FormField label="Cover type">
            <select
              value={form.cover_type}
              onChange={(e) => updateField("cover_type", e.target.value)}
              style={formInputStyle}
            >
              <option value="all_risks">All Risks</option>
              <option value="fire_collision_overturning_theft_hijack">
                Restricted - Fire/Collision/Overturning/Theft-Hijack (80%)
              </option>
              <option value="fire_collision_overturning_only">
                Restricted - Fire/Collision/Overturning only (75%)
              </option>
            </select>
          </FormField>
          <FormField label="Fleet age">
            <select
              value={form.fleet_age}
              onChange={(e) => updateField("fleet_age", e.target.value)}
              style={formInputStyle}
            >
              <option value="new">New</option>
              <option value="over_10yr">Over 10 years</option>
            </select>
          </FormField>
          <FormField label="Night ops">
            <select
              value={form.night_ops}
              onChange={(e) => updateField("night_ops", e.target.value)}
              style={formInputStyle}
            >
              <option value="under_30pct">Under 30%</option>
              <option value="over_30pct">Over 30%</option>
            </select>
          </FormField>
          <FormField label="Cross-border">
            <select
              value={form.cross_border}
              onChange={(e) => updateField("cross_border", e.target.value)}
              style={formInputStyle}
            >
              <option value="local">Local</option>
              <option value="sadc">SADC</option>
            </select>
          </FormField>
        </div>
      </div>

      <div style={{ marginBottom: "20px" }}>
        <SectionLabel>IoT devices fitted</SectionLabel>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "6px", marginTop: "10px" }}>
          {Object.keys(GIT_IOT_CREDITS).map((device) => (
            <label key={device} style={checkboxLabelStyle}>
              <input
                type="checkbox"
                checked={form.iot_devices_fitted.includes(device)}
                onChange={() => toggleIotDevice(device)}
              />
              {device.replace(/_/g, " ")}
            </label>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: "24px" }}>
        <SectionLabel>Security &amp; scope</SectionLabel>
        <div style={{ fontSize: "0.78rem", color: "#5C6570", marginTop: "10px", marginBottom: "12px", lineHeight: 1.5 }}>
          If both "High-value cargo" and "RMP1-scoped fleet" are checked, cover cannot bind unless a security device is selected below.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "6px", marginBottom: "16px" }}>
          <label style={checkboxLabelStyle}>
            <input
              type="checkbox"
              checked={form.is_high_value_cargo}
              onChange={(e) => updateField("is_high_value_cargo", e.target.checked)}
            />
            High-value cargo
          </label>
          <label style={checkboxLabelStyle}>
            <input
              type="checkbox"
              checked={form.is_rmp1_scoped}
              onChange={(e) => updateField("is_rmp1_scoped", e.target.checked)}
            />
            RMP1-scoped fleet (mandatory security requirement applies)
          </label>
          <label style={checkboxLabelStyle}>
            <input
              type="checkbox"
              checked={form.cargosnap_fitted}
              onChange={(e) => updateField("cargosnap_fitted", e.target.checked)}
            />
            Cargosnap fitted
          </label>
        </div>
        <FormField label="Security device fitted (CV+TS+CPI)">
          <select
            value={form.cvtscpi_rmp_tier}
            onChange={(e) => updateField("cvtscpi_rmp_tier", e.target.value)}
            style={formInputStyle}
          >
            <option value="none">None fitted</option>
            <option value="rmp1_top_lock">RMP1 - Top Lock</option>
            <option value="rmp2_cable_lock">RMP2 - Cable Lock</option>
            <option value="rmp3_tracktag">RMP3 - TrackTag</option>
          </select>
        </FormField>
      </div>

      <button
        className="tx-btn"
        onClick={computeQuote}
        style={{
          background: "#14213D",
          color: "#FAF7F0",
          border: "none",
          borderRadius: "5px",
          padding: "10px 20px",
          fontSize: "0.9rem",
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: "'Inter', sans-serif",
          marginBottom: "24px",
        }}
      >
        Compute quote
      </button>

      {result && !result.error && result.verdict === "REFER" && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "20px", marginBottom: "20px" }}>
            <StampBadge verdict="REFER" />
            <div>
              <div style={{ fontSize: "0.95rem", fontWeight: 600, color: "#14213D", lineHeight: 1.4 }}>
                {(result.referral_reasons && result.referral_reasons[0]) || "Requires management review"}
              </div>
              <div style={{ fontSize: "0.75rem", color: "#5C6570", marginTop: "2px" }}>
                Refer to management — no premium calculated
              </div>
            </div>
          </div>
          {(result.referral_reasons || []).length > 1 && (
            <div style={{ marginTop: "16px" }}>
              <SectionLabel>All referral reasons</SectionLabel>
              <ul style={{ margin: "8px 0 0", paddingLeft: "18px", fontSize: "0.82rem", color: "#5C6570", lineHeight: 1.6 }}>
                {result.referral_reasons.map((reason, i) => (
                  <li key={i}>{reason}</li>
                ))}
              </ul>
            </div>
          )}
          <div style={{ marginTop: "20px", borderTop: "1px solid #E4DCC9", paddingTop: "16px" }}>
            <SectionLabel>Management override</SectionLabel>
            <div style={{ fontSize: "0.78rem", color: "#5C6570", marginTop: "8px", marginBottom: "12px", lineHeight: 1.5 }}>
              If management has reviewed and approved this fleet despite the referral, enter details below to compute a quote.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "12px", marginBottom: "12px" }}>
              <FormField label="Approved by">
                <input
                  type="text"
                  value={overrideApproverName}
                  onChange={(e) => setOverrideApproverName(e.target.value)}
                  style={formInputStyle}
                />
              </FormField>
              {isExcludedCommodity && (
                <FormField label="Manual loading factor">
                  <input
              onFocus={(e) => setTimeout(() => e.target.select(), 0)}
                    type="number"
                    step="0.01"
                    value={manualFactorInput}
                    onChange={(e) => setManualFactorInput(e.target.value)}
                    onWheel={(e) => e.target.blur()}
                    placeholder="e.g. 2.50"
                    style={formInputStyle}
                  />
                </FormField>
              )}
            </div>
            <FormField label="Reason for override">
              <input
                type="text"
                value={overrideReasonText}
                onChange={(e) => setOverrideReasonText(e.target.value)}
                placeholder="Why is this approved despite the referral?"
                style={formInputStyle}
              />
            </FormField>
            <button
              className="tx-btn"
              onClick={applyOverride}
              disabled={!overrideReady}
              style={{
                marginTop: "14px",
                background: overrideReady ? "#14213D" : "#C9C2B2",
                color: "#FAF7F0",
                border: "none",
                borderRadius: "5px",
                padding: "10px 20px",
                fontSize: "0.9rem",
                fontWeight: 600,
                cursor: overrideReady ? "pointer" : "not-allowed",
                fontFamily: "'Inter', sans-serif",
              }}
            >
              Override and compute quote
            </button>
          </div>
        </div>
      )}

      {result && !result.error && result.verdict !== "REFER" && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "20px", marginBottom: "24px" }}>
            <StampBadge verdict={result.verdict.startsWith("QUOTABLE") ? "QUOTABLE" : "CANNOT BIND"} />
            <div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "1.4rem", fontWeight: 700 }}>
                {result.total_monthly_premium != null ? "R" + result.total_monthly_premium.toLocaleString() : "\u2014"}
              </div>
              <div style={{ fontSize: "0.75rem", color: "#5C6570" }}>Total monthly premium</div>
            </div>
          </div>

          {result.override_applied && (
            <div style={{ background: "#FCEFDD", border: "1px solid #B5762A", borderRadius: "6px", padding: "14px 16px", marginBottom: "20px" }}>
              <div style={{ fontSize: "0.82rem", fontWeight: 600, color: "#14213D" }}>
                Management override applied
              </div>
              <div style={{ fontSize: "0.82rem", color: "#5C6570", marginTop: "4px" }}>
                Approved by {result.override_approver_name}: {result.override_reason}
              </div>
              <div style={{ fontSize: "0.78rem", color: "#5C6570", marginTop: "6px" }}>
                Original referral reason(s): {(result.bypassed_referral_reasons || []).join("; ")}
              </div>
              {result.manual_factor_used && (
                <div style={{ fontSize: "0.78rem", color: "#5C6570", marginTop: "4px" }}>
                  Priced using manually entered loading factor: {result.commodity_factor_applied}
                </div>
              )}
            </div>
          )}

          <div style={{ background: "#F1ECE0", borderRadius: "6px", padding: "16px 18px", marginBottom: "20px" }}>
            <div style={{ fontSize: "0.9rem", lineHeight: 1.5 }}>{result.verdict}</div>
            <div style={{ fontSize: "0.82rem", color: "#5C6570", marginTop: "6px" }}>
              {result.mandatory_security.note}
            </div>
            {result.min_premium_applied && (
              <div style={{ fontSize: "0.82rem", color: "#B5762A", marginTop: "6px" }}>
                Minimum annual premium floor (R5,000) applied - calculated premium was below the floor.
              </div>
            )}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "10px", marginBottom: "22px" }}>
            <StatBox label="Base PVPM" value={"R" + result.base_pvpm.toLocaleString()} />
            <StatBox label="Loaded PVPM" value={"R" + result.loaded_pvpm.toLocaleString()} />
            <StatBox label="Final PVPM" value={"R" + result.final_pvpm.toLocaleString()} />
            <StatBox label="Vehicle count" value={result.vehicle_count} />
            <StatBox label="Annual premium" value={result.annual_premium != null ? "R" + result.annual_premium.toLocaleString() : "\u2014"} />
            <StatBox label="IoT credit" value={(result.iot_credit.total_credit * 100).toFixed(0) + "%"} />
          </div>

          {Array.isArray(result.iot_credit.detail) && result.iot_credit.detail.length > 0 && (
            <div>
              <SectionLabel>Credit breakdown</SectionLabel>
              <ul style={{ margin: "8px 0 0", paddingLeft: "18px", fontSize: "0.82rem", color: "#5C6570", lineHeight: 1.6 }}>
                {result.iot_credit.detail.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </div>
          )}
          {typeof result.iot_credit.detail === "string" && (
            <div style={{ fontSize: "0.82rem", color: "#5C6570" }}>{result.iot_credit.detail}</div>
          )}
          <div style={{ marginTop: "16px", textAlign: "right" }}>
            <button
              className="tx-btn"
              onClick={() => generateGitQuotePDF(form, result)}
              style={{ background: "#14213D", color: "#fff", border: "none", padding: "10px 24px", borderRadius: "6px", fontSize: "0.88rem", cursor: "pointer", fontWeight: 600 }}
            >
              Download Quote (PDF)
            </button>
          </div>
        </div>
      )}
      {result && result.error && (
        <div style={{ color: "#B23A2E", fontSize: "0.85rem", fontFamily: "'IBM Plex Mono', monospace" }}>
          {result.error}
        </div>
      )}
    </div>
  );
}

function FormField({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: "0.72rem", color: "#5C6570", marginBottom: "4px" }}>{label}</div>
      {children}
    </div>
  );
}

const formInputStyle = {
  width: "100%",
  padding: "8px 10px",
  fontSize: "0.85rem",
  fontFamily: "'Inter', sans-serif",
  border: "1.5px solid #14213D",
  borderRadius: "5px",
  background: "#FAF7F0",
  color: "#14213D",
};

const checkboxLabelStyle = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  fontSize: "0.82rem",
  color: "#14213D",
  cursor: "pointer",
};
const resetBtnStyle = {
  background: "transparent",
  border: "1.5px solid #14213D",
  color: "#14213D",
  borderRadius: "5px",
  padding: "8px 16px",
  fontSize: "0.85rem",
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "'Inter', sans-serif",
};

function FleetVerdictView({ extracted, result }) {
  const fs = extracted.fleet_summary || {};
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "20px", marginBottom: "24px" }}>
        <StampBadge verdict={result.verdict} />
        <div>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "1.4rem", fontWeight: 700 }}>
            {result.latest.combined_score_used != null ? result.latest.combined_score_used.toFixed(0) : "—"}
          </div>
          <div style={{ fontSize: "0.75rem", color: "#5C6570" }}>Latest combined score</div>
        </div>
      </div>

      <div style={{ background: "#F1ECE0", borderRadius: "6px", padding: "16px 18px", marginBottom: "20px" }}>
        <div style={{ fontSize: "0.9rem", lineHeight: 1.5 }}>{result.detail}</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "10px", marginBottom: "22px" }}>
        <StatBox label="Avg vehicles" value={fs.avg_vehicles ?? "—"} />
        <StatBox label="Avg km/vehicle/mo" value={fs.avg_km_per_vehicle_month ?? "—"} />
        <StatBox label="Static risk score" value={extracted.static_risk?.score != null ? extracted.static_risk.score : "—"} />
      </div>
      {extracted.static_risk?.note && (
        <div style={{ fontSize: "0.78rem", color: "#5C6570", marginTop: "-14px", marginBottom: "20px", lineHeight: 1.5 }}>
          Static risk note: {extracted.static_risk.note}
        </div>
      )}

      {extracted.low_confidence_fields?.length > 0 && (
        <div style={{ marginBottom: "20px" }}>
          <SectionLabel>Fields not verifiable from this document</SectionLabel>
          <ul style={{ margin: "8px 0 0", paddingLeft: "18px", fontSize: "0.82rem", color: "#5C6570", lineHeight: 1.6 }}>
            {extracted.low_confidence_fields.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>
      )}

      {extracted.monthly_data?.length > 0 && (
        <div>
          <SectionLabel>Monthly audit trail</SectionLabel>
          <div style={{ overflowX: "auto", marginTop: "8px" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
              <thead>
                <tr style={{ borderBottom: "1.5px solid #14213D" }}>
                  <th style={thStyle}>Month</th>
                  <th style={thStyle}>Combined score</th>
                  <th style={thStyle}>Triggers</th>
                </tr>
              </thead>
              <tbody>
                {result.monthlyResults.map((m, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid #E4DCC9" }}>
                    <td style={tdStyle}>{m.month || `#${i + 1}`}</td>
                    <td style={{ ...tdStyle, fontFamily: "'IBM Plex Mono', monospace" }}>
                      {m.combined_score_used != null ? m.combined_score_used.toFixed(0) : "—"}
                    </td>
                    <td style={{ ...tdStyle, color: m.triggers.length ? "#B23A2E" : "#5C6570" }}>
                      {m.triggers.length ? m.triggers.join("; ") : "clean"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function PolicyScheduleView({ extracted }) {
  const p = extracted.policy_details || {};
  return (
    <div>
      <div
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: "0.75rem",
          color: "#B5762A",
          marginBottom: "16px",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        Policy schedule — not scored
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "10px" }}>
        <StatBox label="Insurer" value={p.insurer ?? "—"} />
        <StatBox label="Policy number" value={p.policy_number ?? "—"} />
        <StatBox label="GIT limit / vehicle" value={p.git_limit_per_vehicle ? `R${p.git_limit_per_vehicle.toLocaleString()}` : "—"} />
        <StatBox label="PVPM rate" value={p.pvpm_rate ? `R${p.pvpm_rate.toFixed(2)}` : "—"} />
        <StatBox label="GIT section — vehicles" value={p.git_section_vehicle_count ?? "—"} />
        <StatBox label="GIT section — premium" value={p.git_section_premium ? `R${p.git_section_premium.toLocaleString()}` : "—"} />
        <StatBox label="Total policy — vehicles" value={p.total_policy_vehicle_count ?? "—"} />
        <StatBox label="Total policy — premium" value={p.total_policy_premium ? `R${p.total_policy_premium.toLocaleString()}` : "—"} />
      </div>
    </div>
  );
}

function StatBox({ label, value }) {
  return (
    <div style={{ background: "#F1ECE0", borderRadius: "6px", padding: "12px 14px" }}>
      <div style={{ fontSize: "0.72rem", color: "#5C6570", marginBottom: "4px" }}>{label}</div>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "0.95rem", fontWeight: 600 }}>{value}</div>
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div
      style={{
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: "0.72rem",
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "#14213D",
        borderBottom: "1.5px solid #14213D",
        paddingBottom: "4px",
      }}
    >
      {children}
    </div>
  );
}

const thStyle = { textAlign: "left", padding: "8px 10px", fontWeight: 600, color: "#14213D" };
const tdStyle = { padding: "8px 10px" };








