import React, { useState, useMemo, useCallback, useRef } from "react";
import * as XLSX from "xlsx";
import {
  checkTrackingGate,
  determineGitCoverTier,
  ORCA_GIT_SETTLEMENT_BASIS,
  classifyExclusion,
  ORCA_TRACKING_RULES,
} from "./orcaUnderwritingRules.js";
import { computePlantRatingFactor, computeAgriRatingFactor } from "./plantAgriEngine.js";

/**
 * MultiCohortView
 * ===============
 * React component for multi-cohort fleet pricing.
 *
 * Accepts sharedFleetInfo from TelematixRater and lets the user split a fleet
 * into multiple asset-class / commodity cohorts, prices each independently
 * using the same GIT load-limit-band engine, then consolidates into a
 * fleet-level premium & weighted multiplier.
 *
 * Includes below-R50k manual override path (Frans-confirmed 25 Jul 2026).
 *
 * Props:
 *   sharedFleetInfo: Fleet data object from FleetInformationView
 */

// ============================================================================
// Constants — copied from TelematixRater.jsx for self-containment.
// When wired into the monolith, these can be shared via a constants module.
// ============================================================================

const GIT_LOAD_LIMIT_MIN_RAND = 50000;
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

const GIT_GEOGRAPHIC_ZONE_LOADING = { western_cape: 1.0, medium_risk: 1.15, gauteng_high_risk: 1.3 };
const GIT_CLAIMS_HISTORY_LOADING = { clean: 1.0, one_claim: 1.15 };
const GIT_FLEET_AGE_LOADING = { new: 1.0, over_10yr: 1.15 };
const GIT_NIGHT_OPS_LOADING = { under_30pct: 1.0, over_30pct: 1.2 };
const GIT_CROSS_BORDER_LOADING = { local: 1.0, sadc: 1.25 };

const GIT_RESTRICTED_COVER_FACTORS = {
  all_risks: 1.0,
  fire_collision_overturning_theft_hijack: 0.8,
  fire_collision_overturning_only: 0.75,
};

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

const GIT_MIN_ANNUAL_PREMIUM = 5000.0;

const COMMODITY_OPTIONS = [
  "coal_mining_bulk", "agricultural_grain", "general_cargo", "building_materials",
  "timber_paper", "refrigerated_goods", "machinery_equipment", "automotive_parts",
  "metals_steel_chrome", "pharmaceuticals", "alcohol_beverages", "fuel_petroleum",
  "electronics_tech", "fmcg_retail_general", "fmcg_branded_high_risk",
];

const ASSET_CLASS_LABELS = {
  hcv_general_freight: "HCV General Freight",
  fuel_hazmat_tanker: "Fuel / Hazmat Tanker",
  minerals_bulk_long_haul: "Minerals / Bulk Long-Haul",
  fmcg_distribution: "FMCG Distribution",
  bulk_liquids_non_hazmat: "Bulk Liquids (non-Hazmat)",
  yellow_metal_plant: "Yellow Metal / Plant",
  agricultural_equipment: "Agricultural Equipment",
  refrigerated_cold_chain: "Refrigerated / Cold Chain",
  abnormal_loads_oversized: "Abnormal Loads / Oversized",
  drone_commercial: "Drone / Commercial",
  trailer: "Trailer",
};

// HCV asset classes — these get the Fleetboard data-source qualifier applied.
// GIT and specialist classes (Plant, Agri) are priced through their own paths.
const HCV_ASSET_CLASSES = new Set([
  "hcv_general_freight",
  "fuel_hazmat_tanker",
  "minerals_bulk_long_haul",
  "fmcg_distribution",
  "bulk_liquids_non_hazmat",
]);

// Data-source qualifier constants (Frans-confirmed Aug 2026 — TelematiX_Ingestion_Matrix.xlsx)
const HCV_QUALIFIER = {
  none:      { factor: 1.40, coverage: 0.0,   label: "No telematics — Profile B cap (1.40×)",                         color: "#B5762A" },
  oem_only:  { factor: 1.40, coverage: 0.612, label: "Fleetboard / OEM only — 61.2% coverage, Profile B cap (1.40×)", color: "#B5762A" },
  oem_video: { factor: 0.70, coverage: 0.962, label: "Fleetboard + video — 96.2% coverage, Profile A eligible (0.70×)", color: "#2E6B3E" },
};
// HCV pricing constants (mirrored from TelematixRater.jsx scoring engine)
const HCV_MANUFACTURER_LOADINGS = {
  mercedes_benz: 0.00, volvo: -0.03, freightliner: -0.10,
  scania: 0.14, faw: 0.10, man_daf: 0.08, western_star: 0.15,
};
const HCV_AGE_BAND_LOADINGS = {
  under_3yr: 0.05, "3_to_5yr": 0.12, "6_to_8yr": 0.22,
  "9_to_11yr": 0.28, "12_to_15yr": 0.15, over_15yr: 0.20,
};
const HCV_BASE_RATE = 0.045;
const HCV_MIN_ANNUAL_PREMIUM = 5000;
const HCV_MANUFACTURER_LOADING_DEFAULT = 0.10; // default for unknown manufacturers

function classifyHcvAgeBandMC(yearModel) {
  const age = new Date().getFullYear() - (yearModel || 2020);
  if (age < 3)  return "under_3yr";
  if (age < 6)  return "3_to_5yr";
  if (age < 9)  return "6_to_8yr";
  if (age < 12) return "9_to_11yr";
  if (age < 16) return "12_to_15yr";
  return "over_15yr";
}

function priceVehicle(vehicle, qualFactor) {
  // Price a single vehicle from the register
  const si = vehicle.insured_value || 0;
  if (si <= 0) return { ...vehicle, annual: 0, monthly: 0 };

  const mfrKey = (vehicle.make || "other").toLowerCase().replace(/[^a-z]/g, "_").replace(/-/g, "_");
  const mfrMap = {
    scania: "scania", mercedes_benz: "mercedes_benz", "mercedes-benz": "mercedes_benz",
    freightliner: "freightliner", volvo: "volvo", man: "man", daf: "daf",
    faw: "faw", hino: "hino", isuzu: "isuzu", western_star: "western_star",
  };
  const mfrLoad = HCV_MANUFACTURER_LOADINGS[mfrMap[mfrKey] || "other"] ?? HCV_MANUFACTURER_LOADING_DEFAULT;
  const ageBand = classifyHcvAgeBandMC(vehicle.year);
  const ageLoad = HCV_AGE_BAND_LOADINGS[ageBand] ?? 0;

  const annual = si * HCV_BASE_RATE * (1 + mfrLoad) * (1 + ageLoad) * qualFactor;
  return {
    ...vehicle,
    mfr_loading: mfrLoad,
    age_band: ageBand,
    age_loading: ageLoad,
    annual: Math.round(annual * 100) / 100,
    monthly: Math.round(annual / 12 * 100) / 100,
  };
}

function priceHcvCohort(cohort, sharedInfo, sharedFleetInfo) {
  // Loss ratio gate
  const lr = cohort.hcv_loss_ratio_pct;
  if (lr != null && lr > 65 && !cohort.hcv_loss_ratio_override_approver) {
    return { ...cohort, status: "REFER", referral_reason: `Loss ratio ${lr.toFixed(1)}% exceeds 65% threshold. Enter approver name to override.`, cohort_monthly: null, cohort_annual: null };
  }

  const ds = cohort.hcv_data_source || "none";
  const qual = HCV_QUALIFIER[ds] || HCV_QUALIFIER.none;

  // Check if we have a vehicle register for per-vehicle pricing
  const register = (sharedFleetInfo?.vehicle_register || sharedInfo?.vehicle_register || []);
  const hcvVehicles = register.filter(v => v.asset_type === "hcv" && (v.insured_value || 0) > 0);

  if (hcvVehicles.length > 0) {
    // PER-VEHICLE PRICING
    const pricedVehicles = hcvVehicles.map(v => priceVehicle(v, qual.factor));
    const totalAnnual = pricedVehicles.reduce((s, v) => s + v.annual, 0);
    const totalSI = pricedVehicles.reduce((s, v) => s + (v.insured_value || 0), 0);
    const minApplied = totalAnnual < HCV_MIN_ANNUAL_PREMIUM;
    const finalAnnual = minApplied ? HCV_MIN_ANNUAL_PREMIUM : totalAnnual;

    return {
      ...cohort,
      status: "QUOTABLE",
      hcv_qualifier: qual,
      total_sum_insured: totalSI,
      vehicle_count: hcvVehicles.length,
      priced_vehicles: pricedVehicles,
      cohort_monthly: Math.round(finalAnnual / 12 * 100) / 100,
      cohort_annual: Math.round(finalAnnual * 100) / 100,
      min_premium_applied: minApplied,
      pricing_mode: "per_vehicle",
    };
  }

  // FALLBACK: cohort-level pricing (no register)
  const count = cohort.vehicle_count || 0;
  const siPerVeh = cohort.hcv_sum_insured_per_vehicle || 0;
  const sumInsured = siPerVeh * count;

  if (sumInsured <= 0 || count <= 0) {
    return { ...cohort, status: "REFER", referral_reason: "Enter sum insured per vehicle and vehicle count to price this cohort.", cohort_monthly: null, cohort_annual: null };
  }

  const mfr = cohort.hcv_manufacturer || "mercedes_benz";
  const mfrLoad = HCV_MANUFACTURER_LOADINGS[mfr] ?? 0;
  const ageBand = classifyHcvAgeBandMC(cohort.hcv_year_model);
  const ageLoad = HCV_AGE_BAND_LOADINGS[ageBand] ?? 0;

  let annual = sumInsured * HCV_BASE_RATE * (1 + mfrLoad) * (1 + ageLoad) * qual.factor;
  let minApplied = false;
  if (annual < HCV_MIN_ANNUAL_PREMIUM) { annual = HCV_MIN_ANNUAL_PREMIUM; minApplied = true; }

  return {
    ...cohort,
    status: "QUOTABLE",
    hcv_qualifier: qual,
    hcv_age_band: ageBand,
    hcv_manufacturer_loading: mfrLoad,
    hcv_age_loading: ageLoad,
    total_sum_insured: sumInsured,
    cohort_monthly: Math.round(annual / 12 * 100) / 100,
    cohort_annual: Math.round(annual * 100) / 100,
    min_premium_applied: minApplied,
    pricing_mode: "cohort_level",
  };
}


// ============================================================================
// Pricing helper — same logic as computeGitPvpm in monolith, but per-cohort
// ============================================================================

function gitLoadLimitBandPvpm(loadLimitPerVehicle, manualOverridePvpm) {
  if (loadLimitPerVehicle < GIT_LOAD_LIMIT_MIN_RAND) {
    // Below-R50k manual override path (Frans-confirmed 25 Jul 2026)
    if (manualOverridePvpm != null && manualOverridePvpm > 0) {
      return {
        pvpm: manualOverridePvpm,
        overrideApplied: true,
        reason: `Load limit R${loadLimitPerVehicle.toLocaleString()} below R50k floor — manual override PVPM applied`,
      };
    }
    return {
      referral: true,
      reason: `Load limit R${loadLimitPerVehicle.toLocaleString()} is below R50,000 minimum — requires management override (enter manual PVPM)`,
    };
  }
  for (const [maxLimit, pvpm] of GIT_LOAD_LIMIT_BAND_PVPM) {
    if (loadLimitPerVehicle <= maxLimit) return { pvpm };
  }
  return {
    referral: true,
    reason: `Load limit R${loadLimitPerVehicle.toLocaleString()} exceeds R1,500,000 — no published rate; management must set bespoke rate`,
  };
}

function computeIotCreditStack(iotDevices, cargosnapFitted, rmpTier) {
  if (iotDevices.length === 0 && !cargosnapFitted && rmpTier === "none") {
    return { total_credit: GIT_NO_IOT_PENALTY, detail: "No IoT devices fitted" };
  }
  let total = 0.0;
  const detail = [];
  for (const device of iotDevices) {
    if (device in GIT_IOT_CREDITS) {
      total += GIT_IOT_CREDITS[device];
      detail.push(`${device}: ${(GIT_IOT_CREDITS[device] * 100).toFixed(0)}%`);
    }
  }
  if (cargosnapFitted) {
    total += GIT_PROPOSED_CARGOSNAP_CREDIT;
    detail.push("cargosnap: -8%");
  }
  if (rmpTier !== "none") {
    const credit = GIT_PROPOSED_CVTSCPI_RMP_CREDITS[rmpTier] ?? 0.0;
    total += credit;
    detail.push(`${rmpTier}: ${(credit * 100).toFixed(0)}%`);
  }
  const capped = Math.max(total, GIT_MAX_IOT_CREDIT);
  return { total_credit: capped, uncapped: total, detail, capped: capped !== total };
}

// Base rates for Plant/Agri (per annum, as % of declared machine value)
const PLANT_BASE_RATE = 0.020;  // 2.0% p.a. of declared value
const AGRI_BASE_RATE  = 0.016;  // 1.6% p.a. of declared value
const PLANT_AGRI_MIN_ANNUAL = 5000; // R5,000 minimum annual premium

function pricePlantCohort(cohort) {
  const machineVal = Number(cohort.machine_value_per_unit) || 0;
  const count = Number(cohort.vehicle_count) || 0;
  if (!machineVal || !count) {
    return { ...cohort, status: "REFER", referral_reason: "Machine value and unit count are required for Yellow Metal / Plant rating." };
  }
  const qualify = computePlantRatingFactor(cohort.plant_data_source || "oemOnly");
  if (qualify.factor >= 2.0) {
    return { ...cohort, status: "REFER", referral_reason: `Data coverage insufficient for Plant rating (coverage ${Math.round(qualify.coverage * 100)}% — minimum 50% required). Fit an insurance-approved SVR unit alongside the OEM device.`, qualify };
  }
  const annualPremiumPerUnit = machineVal * PLANT_BASE_RATE * qualify.factor;
  let annualPremium = annualPremiumPerUnit * count;
  let minPremiumApplied = false;
  if (annualPremium < PLANT_AGRI_MIN_ANNUAL) { annualPremium = PLANT_AGRI_MIN_ANNUAL; minPremiumApplied = true; }
  const monthlyPremium = annualPremium / 12;
  return {
    ...cohort,
    status: "QUOTABLE",
    qualify,
    base_rate: PLANT_BASE_RATE,
    rating_factor: qualify.factor,
    profile: qualify.profile,
    machine_value_per_unit: machineVal,
    annual_premium_per_unit: Math.round(annualPremiumPerUnit * 100) / 100,
    cohort_monthly: Math.round(monthlyPremium * 100) / 100,
    cohort_annual: Math.round(annualPremium * 100) / 100,
    min_premium_applied: minPremiumApplied,
  };
}

function priceAgriCohort(cohort) {
  const machineVal = Number(cohort.machine_value_per_unit) || 0;
  const count = Number(cohort.vehicle_count) || 0;
  const machineType = cohort.agri_machine_type || "tractor";
  if (!machineVal || !count) {
    return { ...cohort, status: "REFER", referral_reason: "Machine value and unit count are required for Agricultural Equipment rating." };
  }
  const qualify = computeAgriRatingFactor(machineType, cohort.agri_data_source || "oemOnly");
  if (qualify.factor >= 2.0) {
    return { ...cohort, status: "REFER", referral_reason: `Data coverage insufficient for Agri rating (${machineType}, coverage ${Math.round(qualify.coverage * 100)}%). Fit approved fire suppression and SVR to reach minimum coverage threshold.`, qualify };
  }
  const annualPremiumPerUnit = machineVal * AGRI_BASE_RATE * qualify.factor;
  let annualPremium = annualPremiumPerUnit * count;
  let minPremiumApplied = false;
  if (annualPremium < PLANT_AGRI_MIN_ANNUAL) { annualPremium = PLANT_AGRI_MIN_ANNUAL; minPremiumApplied = true; }
  const monthlyPremium = annualPremium / 12;
  return {
    ...cohort,
    status: "QUOTABLE",
    qualify,
    base_rate: AGRI_BASE_RATE,
    rating_factor: qualify.factor,
    profile: qualify.profile,
    machine_type: machineType,
    machine_value_per_unit: machineVal,
    annual_premium_per_unit: Math.round(annualPremiumPerUnit * 100) / 100,
    cohort_monthly: Math.round(monthlyPremium * 100) / 100,
    cohort_annual: Math.round(annualPremium * 100) / 100,
    min_premium_applied: minPremiumApplied,
  };
}

function priceGitCohort(cohort, sharedFields) {
  const loadResult = gitLoadLimitBandPvpm(cohort.load_limit_per_vehicle, cohort.manual_override_pvpm);
  if (loadResult.referral) {
    return {
      ...cohort,
      status: "REFER",
      referral_reason: loadResult.reason,
      base_pvpm: null,
      final_pvpm: null,
      cohort_monthly: null,
      cohort_annual: null,
    };
  }
  const basePvpm = loadResult.pvpm;
  const geo = GIT_GEOGRAPHIC_ZONE_LOADING[sharedFields.geographic_zone] ?? 1.0;
  const claims = GIT_CLAIMS_HISTORY_LOADING[sharedFields.claims_history] ?? 1.0;
  const age = GIT_FLEET_AGE_LOADING[sharedFields.fleet_age] ?? 1.0;
  const night = GIT_NIGHT_OPS_LOADING[sharedFields.night_ops] ?? 1.0;
  const cross = GIT_CROSS_BORDER_LOADING[sharedFields.cross_border] ?? 1.0;
  let loadedPvpm = basePvpm * geo * claims * age * night * cross;
  const restricted = GIT_RESTRICTED_COVER_FACTORS[sharedFields.cover_type] ?? 1.0;
  loadedPvpm *= restricted;
  const iot = computeIotCreditStack(
    sharedFields.iot_devices_fitted || [],
    sharedFields.cargosnap_fitted || false,
    sharedFields.cvtscpi_rmp_tier || "none"
  );
  const finalPvpm = loadedPvpm + loadedPvpm * iot.total_credit;
  let monthlyPremium = finalPvpm * cohort.vehicle_count;
  let annualPremium = monthlyPremium * 12;
  let minPremiumApplied = false;
  if (annualPremium < GIT_MIN_ANNUAL_PREMIUM) {
    annualPremium = GIT_MIN_ANNUAL_PREMIUM;
    monthlyPremium = GIT_MIN_ANNUAL_PREMIUM / 12;
    minPremiumApplied = true;
  }
  return {
    ...cohort,
    status: "QUOTABLE",
    base_pvpm: Math.round(basePvpm * 100) / 100,
    loaded_pvpm: Math.round(loadedPvpm * 100) / 100,
    final_pvpm: Math.round(finalPvpm * 100) / 100,
    iot_credit: iot,
    cohort_monthly: Math.round(monthlyPremium * 100) / 100,
    cohort_annual: Math.round(annualPremium * 100) / 100,
    min_premium_applied: minPremiumApplied,
    override_applied: loadResult.overrideApplied || false,
    override_reason: loadResult.reason || null,
    loadings: { geo, claims, age, night, cross, restricted },
    multiplier: Math.round((finalPvpm / basePvpm) * 100) / 100,
  };
}

// Trailer pricing constants (market-validated from real Lombard/Renasa policies)
const TRAILER_BASE_RATE = 0.020; // 2.0% p.a. of declared value
const TRAILER_MIN_ANNUAL_PREMIUM = 5000;
const TRAILER_TYPE_LABELS = {
  tautliner: "Tautliner / Curtainsider",
  flatdeck: "Flatdeck",
  tanker: "Tanker (non-hazmat)",
  side_tipper: "Side Tipper",
  interlink: "Interlink",
  refrigerated: "Refrigerated Trailer",
  other: "Other / Unspecified",
};

function priceTrailerCohort(cohort, sharedFleetInfo) {
  // Try per-vehicle pricing from register first
  const register = sharedFleetInfo?.vehicle_register || [];
  const trailers = register.filter(v => v.asset_type === "trailer" && (v.insured_value || 0) > 0);

  if (trailers.length > 0) {
    const pricedTrailers = trailers.map(v => {
      const annual = (v.insured_value || 0) * TRAILER_BASE_RATE;
      return { ...v, annual: Math.round(annual * 100) / 100, monthly: Math.round(annual / 12 * 100) / 100 };
    });
    const totalAnnual = pricedTrailers.reduce((s, v) => s + v.annual, 0);
    const totalSI = pricedTrailers.reduce((s, v) => s + (v.insured_value || 0), 0);
    const minApplied = totalAnnual < TRAILER_MIN_ANNUAL_PREMIUM;
    const finalAnnual = minApplied ? TRAILER_MIN_ANNUAL_PREMIUM : totalAnnual;
    return {
      ...cohort,
      status: "QUOTABLE",
      trailer_total_si: totalSI,
      vehicle_count: trailers.length,
      priced_trailers: pricedTrailers,
      cohort_monthly: Math.round(finalAnnual / 12 * 100) / 100,
      cohort_annual: Math.round(finalAnnual * 100) / 100,
      min_premium_applied: minApplied,
      pricing_mode: "per_vehicle",
    };
  }

  // Fallback: cohort-level
  const count = cohort.vehicle_count || 0;
  const siPerUnit = cohort.trailer_sum_insured_per_unit || 0;
  const totalSI = siPerUnit * count;
  if (totalSI <= 0 || count <= 0) {
    return { ...cohort, status: "REFER", referral_reason: "Enter sum insured per trailer and unit count to price this cohort.", cohort_monthly: null, cohort_annual: null };
  }
  let annual = totalSI * TRAILER_BASE_RATE;
  let minApplied = false;
  if (annual < TRAILER_MIN_ANNUAL_PREMIUM) { annual = TRAILER_MIN_ANNUAL_PREMIUM; minApplied = true; }
  return {
    ...cohort, status: "QUOTABLE", trailer_total_si: totalSI,
    cohort_monthly: Math.round(annual / 12 * 100) / 100,
    cohort_annual: Math.round(annual * 100) / 100,
    min_premium_applied: minApplied, pricing_mode: "cohort_level",
  };
}

function priceCohort(cohort, sharedFields, sharedFleetInfo) {
  const cls = cohort.asset_class || "hcv_general_freight";
  if (cls === "yellow_metal_plant") return pricePlantCohort(cohort);
  if (cls === "agricultural_equipment") return priceAgriCohort(cohort);
  if (cls === "trailer") return priceTrailerCohort(cohort, sharedFleetInfo);
  if (HCV_ASSET_CLASSES.has(cls)) return priceHcvCohort(cohort, sharedFields, sharedFleetInfo);
  return priceGitCohort(cohort, sharedFields);
}

// ============================================================================
// Default cohort factory
// ============================================================================

function makeCohort(index, shared) {
  return {
    id: `cohort-${Date.now()}-${index}`,
    label: `Cohort ${index + 1}`,
    asset_class: shared?.asset_class || "hcv_general_freight",
    commodity_type: shared?.commodity_type || "general_cargo",
    vehicle_count: shared?.vehicle_count || 0,
    load_limit_per_vehicle: shared?.load_limit_per_vehicle || 0,
    manual_override_pvpm: null,
    // ORCA underwriting fields (25 Jul 2026)
    goods_is_new: true,
    goods_fully_enclosed_or_tarpaulin: true,
    goods_is_livestock: false,
    tracking_device_vendor: "",
    tracking_device_category: "",
    // Plant / Yellow Metal fields
    plant_data_source: "oemOnly",
    machine_value_per_unit: 0,
    // Agri fields
    agri_machine_type: "tractor",
    agri_data_source: "oemOnly",
    // Trailer-specific fields
    trailer_sum_insured_per_unit: 0,
    trailer_type: "tautliner",
    // HCV-specific fields
    hcv_sum_insured_per_vehicle: shared?.avg_sum_insured_per_vehicle || 0,
    hcv_manufacturer: shared?.manufacturer || "mercedes_benz",
    hcv_year_model: shared?.year_model || new Date().getFullYear(),
    hcv_data_source: shared?.hcv_data_source || "oem_only",
    hcv_loss_ratio_pct: null,
    hcv_loss_ratio_override_approver: "",
    hcv_loss_ratio_override_reason: "",
  };
}

/**
 * Compute ORCA underwriting status for a cohort: GIT cover tier, settlement
 * basis, and tracking-gate compliance. Runs alongside pricing but does not
 * change the premium — it flags underwriting conditions the broker/UW needs
 * to see before the quote can bind.
 */
function computeUnderwritingStatus(cohort) {
  const coverTier = determineGitCoverTier({
    isNew: cohort.goods_is_new,
    isFullyEnclosedOrTarpaulin: cohort.goods_fully_enclosed_or_tarpaulin,
    isLivestock: cohort.goods_is_livestock,
  });

  const settlementBasis = cohort.goods_is_livestock
    ? "N/A — livestock settled per Merx-pattern death/humane-killing basis"
    : cohort.goods_is_new
    ? ORCA_GIT_SETTLEMENT_BASIS.new_goods
    : ORCA_GIT_SETTLEMENT_BASIS.second_hand;

  const perVehicleValue =
    cohort.vehicle_count > 0 ? cohort.load_limit_per_vehicle : 0;

  const trackingStatus = checkTrackingGate({
    insuredValue: perVehicleValue,
    deviceVendor: cohort.tracking_device_vendor,
    deviceCategory: cohort.tracking_device_category,
    device_fitted_prior_to_incident: true,
    device_operational_at_time_of_incident: true,
    valid_supplier_contract_with_subscription_paid: true,
    monitored_24hr_by_manned_control_room: true,
    supplier_notifies_insured_immediately_on_activation: true,
  });

  const exclusionCheck = classifyExclusion(cohort.commodity_type || "");

  return { coverTier, settlementBasis, trackingStatus, exclusionCheck };
}

// ============================================================================
// Component
// ============================================================================

const CLAIMS_EXTRACTION_PROMPT = `You are extracting claims history data from a transport/fleet insurance document.
Return ONLY a valid JSON object — no preamble, no explanation, no markdown fences.

Extract the following structure:
{
  "fleet_name": string or null,
  "period_start": "YYYY-MM" or null,
  "period_end": "YYYY-MM" or null,
  "stated_loss_ratio_pct": number or null,
  "years": [
    {
      "year": number,
      "premium": number or null,
      "claims": number or null,
      "loss_ratio_pct": number or null,
      "claim_count": number or null,
      "is_complete": true or false
    }
  ],
  "line_items": [
    {
      "description": string,
      "amount": number,
      "year": number or null,
      "type": "motor" | "git" | "other" | null
    }
  ],
  "extraction_notes": string
}

Rules:
- Aggregate monthly data into calendar years.
- Add is_complete field per year: false if the year contains projected/future months with zero claims but non-zero premium (these distort the loss ratio), true otherwise.
- ALWAYS compute loss_ratio_pct per year: (claims / premium) * 100. This is mandatory — never leave it null when premium and claims are both available.
- Include ALL claim line items you can identify in line_items.
- If no line-item breakdown exists, set line_items to [].
- extraction_notes: describe what you found, any outlier months, projected months, and data quality issues.
- IMPORTANT: you MUST compute per-year loss_ratio_pct values.`;

export default function MultiCohortView({ sharedFleetInfo }) {
  const shared = sharedFleetInfo || {};
  const [cohorts, setCohorts] = useState(() => [makeCohort(0, shared)]);

  // Reset cohorts when fleet_name changes — auto-create trailer cohort from vehicle register
  const prevFleetNameRef = useRef(null);
  React.useEffect(() => {
    const newName = shared?.fleet_name;
    if (newName && newName !== prevFleetNameRef.current) {
      prevFleetNameRef.current = newName;
      const hcvCohort = makeCohort(0, shared);
      const newCohorts = [hcvCohort];

      // Compute trailer data directly from vehicle register
      const register = shared?.vehicle_register || [];
      const trailers = register.filter(v => v.asset_type === "trailer" && (v.insured_value || 0) > 0);
      const trailerCount = trailers.length;
      const trailerTotalSI = trailers.reduce((s, v) => s + (v.insured_value || 0), 0);
      const trailerAvgSI = trailerCount > 0 ? Math.round(trailerTotalSI / trailerCount) : 0;

      // Fallback to explicit fields if register has no trailers
      const useTrailerCount = trailerCount > 0 ? trailerCount : (shared?.trailer_count || 0);
      const useTrailerAvgSI = trailerCount > 0 ? trailerAvgSI : (shared?.trailer_avg_sum_insured || 0);

      if (useTrailerCount > 0 && useTrailerAvgSI > 0) {
        const trailerCohort = {
          ...makeCohort(1, shared),
          asset_class: "trailer",
          vehicle_count: useTrailerCount,
          trailer_sum_insured_per_unit: useTrailerAvgSI,
          trailer_type: "tautliner",
          label: "Cohort 2",
        };
        newCohorts.push(trailerCohort);
      }
      setCohorts(newCohorts);
    }
  }, [shared?.fleet_name]);
  const [expandedCohort, setExpandedCohort] = useState(0);
  const [overrideApproverName, setOverrideApproverName] = useState("");

  // Claims History intake state
  const [claimsStatus, setClaimsStatus]   = useState("idle"); // idle | reading | extracting | done | error
  const [claimsError, setClaimsError]     = useState(null);
  const [claimsStepA, setClaimsStepA]     = useState(null);   // Step A extraction result
  const [claimsStep, setClaimsStep]       = useState("A");    // "A" | "B_auto" | "B_manual"
  const [claimsApplied, setClaimsApplied] = useState(false);
  const [claimsDragOver, setClaimsDragOver] = useState(false);
  // Manual split grid: { [cohortId]: { [year]: { motor: %, git: %, other: % } } }
  const [manualSplit, setManualSplit]      = useState({});
  const claimsInputRef = useRef(null);

  // ── Claims History processing ───────────────────────────────────────────────
  const processClaimsFile = useCallback(async (file) => {
    if (!file) return;
    const name = file.name.toLowerCase();
    const isPdf   = file.type === "application/pdf" || name.endsWith(".pdf");
    const isExcel = name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".csv");
    if (!isPdf && !isExcel) {
      setClaimsError("Please provide a PDF or Excel (.xlsx/.xls/.csv) file.");
      setClaimsStatus("error");
      return;
    }
    setClaimsStatus("reading");
    setClaimsError(null);
    setClaimsStepA(null);
    setClaimsStep("A");
    setClaimsApplied(false);

    try {
      let requestBody;
      if (isExcel) {
        const arrayBuffer = await file.arrayBuffer();
        const workbook = XLSX.read(arrayBuffer, { type: "array" });
        const csvSheets = workbook.SheetNames.map((sn) => {
          const sheet = workbook.Sheets[sn];
          return `Sheet: ${sn}\n${XLSX.utils.sheet_to_csv(sheet, { blankrows: false })}`;
        }).join("\n\n");
        setClaimsStatus("extracting");
        requestBody = JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 4000,
          system: "You are a data extraction assistant. Respond with valid JSON only. No preamble, no markdown fences.",
          messages: [{ role: "user", content: [{ type: "text", text: `${CLAIMS_EXTRACTION_PROMPT}\n\nDocument content (Excel converted to CSV):\n${csvSheets}` }] }],
        });
      } else {
        const reader = new FileReader();
        const b64 = await new Promise((res, rej) => {
          reader.onload = () => res(reader.result.split(",")[1]);
          reader.onerror = rej;
          reader.readAsDataURL(file);
        });
        setClaimsStatus("extracting");
        requestBody = JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 4000,
          system: "You are a data extraction assistant. Respond with valid JSON only. No preamble, no markdown fences.",
          messages: [{ role: "user", content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
            { type: "text", text: CLAIMS_EXTRACTION_PROMPT }
          ]}],
        });
      }

      const response = await fetch("https://telematix-rater-backend.onrender.com/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
      });

      if (!response.ok) throw new Error(`Server error: ${response.status}`);
      const data = await response.json();
      const rawText = (data.content || []).map(b => b.text || "").join("").trim()
        .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```\s*$/i, "").trim();
      const extracted = JSON.parse(rawText);
      setClaimsStepA(extracted);
      setClaimsStatus("done");
    } catch (err) {
      setClaimsStatus("error");
      setClaimsError("Extraction failed: " + (err.message || String(err)));
    }
  }, []);

  const applyClaimsToCohorts = useCallback((splitPct) => {
    if (!claimsStepA || !claimsStepA.years) return;
    // Only use complete years (exclude projected/future months)
    const years = claimsStepA.years.filter(y => y.is_complete !== false);
    const allYears = claimsStepA.years; // fallback if no complete years flagged
    const useYears = years.length > 0 ? years : allYears;

    const totalClaims  = useYears.reduce((s, y) => s + (y.claims  || 0), 0);
    const totalPremium = useYears.reduce((s, y) => s + (y.premium || 0), 0);
    const overallLR    = totalPremium > 0 ? (totalClaims / totalPremium) * 100 : null;

    setCohorts(prev => prev.map(c => {
      const pct           = (splitPct[c.id] ?? 0) / 100;
      const cohortClaims  = totalClaims  * pct;
      const cohortPremium = totalPremium * pct;
      const cohortLR      = cohortPremium > 0 ? (cohortClaims / cohortPremium) * 100 : overallLR;
      const lr            = cohortLR != null ? Math.round(cohortLR * 10) / 10 : null;
      return { ...c, hcv_loss_ratio_pct: lr, _claims_applied: Date.now() };
    }));
    setClaimsApplied(true);
  }, [claimsStepA]);

  const newCohortRef = useRef(null);

  const addCohort = useCallback(() => {
    setCohorts((prev) => [...prev, makeCohort(prev.length, shared)]);
    setTimeout(() => {
      if (newCohortRef.current) {
        newCohortRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }, 100);
  }, [shared]);

  const removeCohort = useCallback((id) => {
    setCohorts((prev) => prev.length > 1 ? prev.filter((c) => c.id !== id) : prev);
  }, []);

  const updateCohort = useCallback((id, key, value) => {
    setCohorts((prev) =>
      prev.map((c) => (c.id === id ? { ...c, [key]: value } : c))
    );
  }, []);

  // Shared pricing fields (inherited from FleetInformationView)
  const sharedFields = useMemo(() => ({
    geographic_zone: shared.geographic_zone || "western_cape",
    claims_history: shared.claims_history || "clean",
    fleet_age: shared.fleet_age || "new",
    night_ops: shared.night_ops || "under_30pct",
    cross_border: shared.cross_border || "local",
    cover_type: shared.cover_type || "all_risks",
    iot_devices_fitted: shared.iot_devices_fitted || [],
    cargosnap_fitted: shared.cargosnap_fitted || false,
    cvtscpi_rmp_tier: shared.cvtscpi_rmp_tier || "none",
    // HCV data-source qualifier (Frans-confirmed Aug 2026)
    hcv_data_source: shared.hcv_data_source || "none",
  }), [shared]);

  // Price all cohorts
  const pricedCohorts = useMemo(() => {
    return cohorts.map((c) => {
      const priced = priceCohort(c, sharedFields, shared);
      const underwriting = computeUnderwritingStatus(c);

      // ORCA underwriting gate: absolute-excluded commodity or failed
      // tracking requirement overrides pricing status to REFER, even if the
      // load-limit-band pricing itself was quotable.
      let status = priced.status;
      let referral_reason = priced.referral_reason;

      if (underwriting.exclusionCheck.status === "absolute_exclusion") {
        status = "REFER";
        referral_reason = `Commodity '${c.commodity_type}' is an ORCA absolute exclusion — not coverable under any circumstance`;
      } else if (underwriting.trackingStatus.required && !underwriting.trackingStatus.met) {
        status = "REFER";
        referral_reason = `Tracking requirement not met: ${underwriting.trackingStatus.reason}`;
      }

      return { ...priced, status, referral_reason, underwriting };
    });
  }, [cohorts, sharedFields]);

  // Fleet-level aggregation
  const fleetSummary = useMemo(() => {
    const quotable = pricedCohorts.filter((c) => c.status === "QUOTABLE");
    const referred = pricedCohorts.filter((c) => c.status === "REFER");
    const totalMonthly = quotable.reduce((s, c) => s + (c.cohort_monthly || 0), 0);
    const totalAnnual = quotable.reduce((s, c) => s + (c.cohort_annual || 0), 0);
    const totalVehicles = quotable.reduce((s, c) => s + c.vehicle_count, 0);
    // Bug fix #6: track referred vehicle count separately so it's visible in
    // the summary rather than silently dropped from the fleet total.
    const referredVehicles = referred.reduce((s, c) => s + (c.vehicle_count || 0), 0);

    // Weighted multiplier across quotable cohorts
    let weightedMult = 1.0;
    if (quotable.length > 0 && totalVehicles > 0) {
      const sumWeighted = quotable.reduce((s, c) => s + (c.multiplier || 1.0) * c.vehicle_count, 0);
      weightedMult = Math.round((sumWeighted / totalVehicles) * 100) / 100;
    }

    return {
      totalMonthly: Math.round(totalMonthly * 100) / 100,
      totalAnnual: Math.round(totalAnnual * 100) / 100,
      totalVehicles,
      referredVehicles,
      cohortCount: pricedCohorts.length,
      quotableCount: quotable.length,
      referredCount: referred.length,
      weightedMultiplier: weightedMult,
    };
  }, [pricedCohorts]);

  // ========================================================================
  // Styles
  // ========================================================================
  const sectionLabelStyle = {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: "0.72rem",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "#14213D",
    borderBottom: "1.5px solid #14213D",
    paddingBottom: "4px",
  };

  const statBoxStyle = {
    background: "#F1ECE0",
    borderRadius: "6px",
    padding: "12px 14px",
    borderLeft: "3px solid #B5762A",
  };

  const statLabel = { fontSize: "0.72rem", color: "#5C6570", marginBottom: "4px" };
  const statValue = { fontFamily: "'IBM Plex Mono', monospace", fontSize: "0.95rem", fontWeight: 600 };

  const inputStyle = {
    width: "100%",
    padding: "8px 10px",
    borderRadius: "4px",
    border: "1px solid #D4C4B0",
    fontSize: "0.85rem",
    fontFamily: "'IBM Plex Mono', monospace",
    background: "#FFFFFF",
  };

  const tabBtnStyle = {
    padding: "6px 16px",
    borderRadius: "6px",
    border: "1.5px solid #14213D",
    cursor: "pointer",
    fontSize: "0.8rem",
    fontFamily: "'Inter', sans-serif",
    fontWeight: 500,
    transition: "background 0.15s, color 0.15s",
  };

  // ========================================================================
  // Render
  // ========================================================================
  return (
    <div>
      {/* Header label */}
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
        Multi-Cohort Fleet Pricing
      </div>

      <div style={{ fontSize: "0.82rem", color: "#5C6570", marginBottom: "20px", lineHeight: 1.5 }}>
        Split a mixed fleet into asset-class / commodity cohorts and price each independently.
        Shared loadings (geography, claims, IoT, cover type) are inherited from Fleet Information.
        Below-R50k loads can be priced via management override.
      </div>

      {/* ---- Fleet-level summary ---- */}
      <div style={{ marginBottom: "24px" }}>
        <div style={sectionLabelStyle}>Fleet-level summary</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "12px", marginTop: "12px" }}>
          <div style={statBoxStyle}>
            <div style={statLabel}>Total monthly premium</div>
            <div style={statValue}>
              {fleetSummary.totalMonthly > 0
                ? `R${fleetSummary.totalMonthly.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : "—"}
            </div>
          </div>
          <div style={statBoxStyle}>
            <div style={statLabel}>Total annual premium</div>
            <div style={statValue}>
              {fleetSummary.totalAnnual > 0
                ? `R${fleetSummary.totalAnnual.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : "—"}
            </div>
          </div>
          <div style={statBoxStyle}>
            <div style={statLabel}>Total vehicles</div>
            <div style={statValue}>
              {fleetSummary.totalVehicles}
              {fleetSummary.referredVehicles > 0 && (
                <span style={{ color: "#B23A2E", fontSize: "0.8rem", marginLeft: "6px" }}>
                  +{fleetSummary.referredVehicles} referred
                </span>
              )}
            </div>
          </div>
          <div style={statBoxStyle}>
            <div style={statLabel}>Weighted multiplier</div>
            <div style={statValue}>{fleetSummary.weightedMultiplier.toFixed(2)}x</div>
          </div>
          <div style={statBoxStyle}>
            <div style={statLabel}>Cohorts</div>
            <div style={statValue}>
              {fleetSummary.quotableCount} quotable
              {fleetSummary.referredCount > 0 && (
                <span style={{ color: "#B23A2E", marginLeft: "6px" }}>
                  / {fleetSummary.referredCount} referred
                </span>
              )}
            </div>
          </div>
          <div style={statBoxStyle}>
            <div style={statLabel}>Shared loadings</div>
            <div style={{ ...statValue, fontSize: "0.78rem" }}>
              {shared.geographic_zone?.replace(/_/g, " ") || "—"} · {shared.cover_type?.replace(/_/g, " ") || "—"}
            </div>
          </div>
        </div>
      </div>

      {fleetSummary.quotableCount > 0 && (
        <div style={{ textAlign: "right", marginBottom: "12px" }}>
          <button
            className="tx-btn"
            onClick={() => {
              import("./generateQuotePDF.js").then((mod) => {
                mod.generateMultiCohortQuotePDF(pricedCohorts, fleetSummary, { ...sharedFields, fleet_name: shared.fleet_name, iot_devices: sharedFields.iot_devices_fitted, night_ops_pct: shared.night_ops_pct || 0 });
              });
            }}
            style={{ background: "#14213D", color: "#fff", border: "none", padding: "10px 24px", borderRadius: "6px", fontSize: "0.88rem", cursor: "pointer", fontWeight: 600 }}
          >
            Download Quote (PDF)
          </button>
        </div>
      )}

      {/* ---- Cohort cards ---- */}
      <div style={{ marginBottom: "16px" }}>
        <div style={{ ...sectionLabelStyle, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>Cohorts ({cohorts.length})</span>
          <button
            className="tx-btn"
            onClick={addCohort}
            style={{
              ...tabBtnStyle,
              fontSize: "0.72rem",
              padding: "4px 12px",
              background: "#14213D",
              color: "#FAF7F0",
              border: "none",
              textTransform: "uppercase",
            }}
          >
            + Add cohort
          </button>
        </div>
      </div>

      {pricedCohorts.map((cohort, idx) => {
        const isExpanded = expandedCohort === idx;
        const isReferred = cohort.status === "REFER";
        const isPlantAgri = cohort.asset_class === "yellow_metal_plant" || cohort.asset_class === "agricultural_equipment";
        const isHcv = HCV_ASSET_CLASSES.has(cohort.asset_class);
        const isTrailer = cohort.asset_class === "trailer";
        const needsOverride = isReferred && !isPlantAgri && !isHcv && !isTrailer && cohort.load_limit_per_vehicle < GIT_LOAD_LIMIT_MIN_RAND;
        const isLastCohort = idx === pricedCohorts.length - 1;

        return (
          <div
            key={cohort.id}
            ref={isLastCohort ? newCohortRef : null}
            style={{
              background: "#FFFFFF",
              border: `1.5px solid ${isReferred ? "#B23A2E" : isExpanded ? "#B5762A" : "#E4DCC9"}`,
              borderRadius: "6px",
              padding: "14px 16px",
              marginBottom: "10px",
              transition: "border-color 0.15s",
            }}
          >
            {/* Cohort header — click to expand */}
            <div
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}
              onClick={() => setExpandedCohort(isExpanded ? null : idx)}
            >
              <div>
                <div style={{ fontSize: "0.9rem", fontWeight: 600, color: "#14213D" }}>
                  <input
                    type="text"
                    value={cohort.label}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => updateCohort(cohort.id, "label", e.target.value)}
                    style={{
                      border: "none",
                      background: "transparent",
                      fontWeight: 600,
                      fontSize: "0.9rem",
                      color: "#14213D",
                      width: "200px",
                    }}
                  />
                </div>
                <div style={{ fontSize: "0.72rem", color: "#5C6570", marginTop: "2px" }}>
                  {cohort.vehicle_count} vehicle{cohort.vehicle_count !== 1 ? "s" : ""}
                  {" · "}
                  {ASSET_CLASS_LABELS[cohort.asset_class] || cohort.asset_class?.replace(/_/g, " ")}
                  {" · "}
                  {isPlantAgri
                    ? `R${(cohort.machine_value_per_unit || 0).toLocaleString()} /machine`
                    : isHcv
                    ? `R${(cohort.hcv_sum_insured_per_vehicle || 0).toLocaleString()} /vehicle`
                    : isTrailer
                    ? `R${(cohort.trailer_sum_insured_per_unit || 0).toLocaleString()} /trailer`
                    : `R${(cohort.load_limit_per_vehicle || 0).toLocaleString()} load limit`}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div
                  style={{
                    fontFamily: "'IBM Plex Mono', monospace",
                    fontSize: "1rem",
                    fontWeight: 700,
                    color: isReferred ? "#B23A2E" : "#B5762A",
                  }}
                >
                  {isReferred
                    ? "REFER"
                    : `R${cohort.cohort_monthly.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/mo`}
                </div>
                {!isReferred && (
                  <div style={{ fontSize: "0.72rem", color: cohort.hcv_qualifier ? cohort.hcv_qualifier.color : "#B5762A" }}>
                    {cohort.asset_class === "yellow_metal_plant" || cohort.asset_class === "agricultural_equipment"
                      ? `${cohort.rating_factor?.toFixed(2)}x · ${cohort.profile}`
                      : HCV_ASSET_CLASSES.has(cohort.asset_class)
                      ? `${cohort.hcv_qualifier?.factor?.toFixed(2)}× qualifier · ${cohort.hcv_age_band?.replace(/_/g," ") || ""} age band`
                      : isTrailer
                      ? `2.0% p.a. · ${(cohort.trailer_type || "tautliner").replace(/_/g," ")}`
                      : `${cohort.multiplier?.toFixed(2)}x · R${cohort.final_pvpm?.toFixed(2)}/veh`}
                  </div>
                )}
                <div style={{ fontSize: "0.62rem", color: "#999", marginTop: "2px" }}>
                  {isExpanded ? "▲" : "▼"}
                </div>
              </div>
            </div>

            {/* Expanded: edit cohort fields */}
            {isExpanded && (
              <div style={{ marginTop: "14px", borderTop: "1px solid #E4DCC9", paddingTop: "14px" }}>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "12px" }}>
                  <div>
                    <div style={{ fontSize: "0.72rem", color: "#5C6570", marginBottom: "4px" }}>Asset class</div>
                    <select
                      value={cohort.asset_class}
                      onChange={(e) => updateCohort(cohort.id, "asset_class", e.target.value)}
                      style={inputStyle}
                    >
                      {Object.entries(ASSET_CLASS_LABELS).map(([key, label]) => (
                        <option key={key} value={key}>{label}</option>
                      ))}
                    </select>
                  </div>
                  {!isPlantAgri && (
                  <div>
                    <div style={{ fontSize: "0.72rem", color: "#5C6570", marginBottom: "4px" }}>Commodity type</div>
                    <select
                      value={cohort.commodity_type}
                      onChange={(e) => updateCohort(cohort.id, "commodity_type", e.target.value)}
                      style={inputStyle}
                    >
                      {COMMODITY_OPTIONS.map((key) => (
                        <option key={key} value={key}>{key.replace(/_/g, " ")}</option>
                      ))}
                    </select>
                  </div>
                  )}
                  <div>
                    <div style={{ fontSize: "0.72rem", color: "#5C6570", marginBottom: "4px" }}>Vehicle count</div>
                    <input
                      type="number"
                      min="0"
                      // Bug fix #5: show empty string when 0 so the user starts
                      // with a blank field — prevents the "07 vehicles" leading
                      // zero display when typing into a zero-initialised input.
                      value={cohort.vehicle_count === 0 ? "" : cohort.vehicle_count}
                      placeholder="0"
                      onFocus={(e) => setTimeout(() => e.target.select(), 0)}
                      onChange={(e) => updateCohort(cohort.id, "vehicle_count", e.target.value === "" ? 0 : Math.max(0, parseInt(e.target.value, 10)) || 0)}
                      onWheel={(e) => e.target.blur()}
                      style={inputStyle}
                    />
                  </div>
                  {!isPlantAgri && !isHcv && !isTrailer && (
                    <div>
                      <div style={{ fontSize: "0.72rem", color: "#5C6570", marginBottom: "4px" }}>Load limit per vehicle (R)</div>
                      <input
                        type="number"
                        min="0"
                        step="10000"
                        value={cohort.load_limit_per_vehicle === 0 ? "" : cohort.load_limit_per_vehicle}
                        placeholder="0"
                        onFocus={(e) => setTimeout(() => e.target.select(), 0)}
                        onChange={(e) => updateCohort(cohort.id, "load_limit_per_vehicle", e.target.value === "" ? 0 : Math.max(0, parseInt(e.target.value, 10)) || 0)}
                        onWheel={(e) => e.target.blur()}
                        style={inputStyle}
                      />
                    </div>
                  )}
                  {isHcv && !isTrailer && (
                    <div>
                      <div style={{ fontSize: "0.72rem", color: "#5C6570", marginBottom: "4px" }}>Sum insured per vehicle (R)</div>
                      <input
                        type="number"
                        min="0"
                        step="10000"
                        value={cohort.hcv_sum_insured_per_vehicle === 0 ? "" : cohort.hcv_sum_insured_per_vehicle}
                        placeholder="0"
                        onFocus={(e) => setTimeout(() => e.target.select(), 0)}
                        onChange={(e) => updateCohort(cohort.id, "hcv_sum_insured_per_vehicle", e.target.value === "" ? 0 : Math.max(0, parseInt(e.target.value, 10)) || 0)}
                        onWheel={(e) => e.target.blur()}
                        style={inputStyle}
                      />
                      {cohort.hcv_sum_insured_per_vehicle > 10000000 && (
                        <div style={{ fontSize: "0.74rem", color: "#B5762A", marginTop: "3px" }}>
                          ⚠ Sum insured per vehicle exceeds R10m — please verify this figure.
                        </div>
                      )}
                    </div>
                  )}
                  {(cohort.asset_class === "yellow_metal_plant" || cohort.asset_class === "agricultural_equipment") && (
                    <div>
                      <div style={{ fontSize: "0.72rem", color: "#5C6570", marginBottom: "4px" }}>Declared value per machine (R)</div>
                      <input
                        type="number"
                        min="0"
                        step="10000"
                        value={cohort.machine_value_per_unit === 0 ? "" : cohort.machine_value_per_unit}
                        placeholder="0"
                        onFocus={(e) => setTimeout(() => e.target.select(), 0)}
                        onChange={(e) => updateCohort(cohort.id, "machine_value_per_unit", e.target.value === "" ? 0 : Math.max(0, parseInt(e.target.value, 10)) || 0)}
                        onWheel={(e) => e.target.blur()}
                        style={inputStyle}
                      />
                    </div>
                  )}
                </div>

                {/* HCV-specific fields */}
                {isHcv && (
                <div style={{ marginTop: "14px", padding: "12px 14px", background: "#F1ECE0", borderRadius: "6px", borderLeft: "3px solid #14213D" }}>
                  <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "#14213D", marginBottom: "10px" }}>HCV Underwriting</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "10px" }}>
                    <div>
                      <div style={{ fontSize: "0.72rem", color: "#5C6570", marginBottom: "4px" }}>Data source (qualifier)</div>
                      <select value={cohort.hcv_data_source || "oem_only"} onChange={(e) => updateCohort(cohort.id, "hcv_data_source", e.target.value)} style={inputStyle}>
                        <option value="none">No telematics — Profile B cap (1.40×)</option>
                        <option value="oem_only">Fleetboard / OEM only — 61.2% coverage (1.40×)</option>
                        <option value="oem_video">Fleetboard + video — 96.2% coverage, Profile A eligible (0.70×)</option>
                      </select>
                    </div>
                    <div>
                      <div style={{ fontSize: "0.72rem", color: "#5C6570", marginBottom: "4px" }}>Manufacturer</div>
                      <select value={cohort.hcv_manufacturer || "mercedes_benz"} onChange={(e) => updateCohort(cohort.id, "hcv_manufacturer", e.target.value)} style={inputStyle}>
                        <option value="mercedes_benz">Mercedes-Benz (0%)</option>
                        <option value="volvo">Volvo (−3%)</option>
                        <option value="freightliner">Freightliner (−10%)</option>
                        <option value="scania">Scania (+14%)</option>
                        <option value="faw">FAW (+10%)</option>
                        <option value="man_daf">MAN / DAF (+8%)</option>
                        <option value="western_star">Western Star (+15%)</option>
                      </select>
                    </div>
                    <div>
                      <div style={{ fontSize: "0.72rem", color: "#5C6570", marginBottom: "4px" }}>Average vehicle year model</div>
                      <input type="number" min="1990" max="2030"
                        value={cohort.hcv_year_model || new Date().getFullYear()}
                        onFocus={(e) => setTimeout(() => e.target.select(), 0)}
                        onChange={(e) => updateCohort(cohort.id, "hcv_year_model", parseInt(e.target.value) || new Date().getFullYear())}
                        style={inputStyle} />
                    </div>
                    <div>
                      <div style={{ fontSize: "0.72rem", color: "#5C6570", marginBottom: "4px" }}>
                        Loss ratio % (leave blank if unknown)
                        {cohort.hcv_loss_ratio_pct != null && <span style={{ color: "#B5762A", marginLeft: "6px" }}>(applied from claims history)</span>}
                      </div>
                      <input type="number" min="0" max="999" placeholder="e.g. 74.2"
                        value={cohort.hcv_loss_ratio_pct ?? ""}
                        onFocus={(e) => setTimeout(() => e.target.select(), 0)}
                        onChange={(e) => updateCohort(cohort.id, "hcv_loss_ratio_pct", e.target.value === "" ? null : parseFloat(e.target.value))}
                        style={inputStyle} />
                    </div>
                  </div>
                  {cohort.hcv_loss_ratio_pct != null && cohort.hcv_loss_ratio_pct > 65 && (
                    <div style={{ background: "#FFF3CD", border: "1px solid #B5762A", borderRadius: "5px", padding: "10px 12px", marginTop: "8px" }}>
                      <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "#B5762A", marginBottom: "6px" }}>⚠ Loss Ratio Referral — Management Override Required</div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                        <input type="text" placeholder="Approver name"
                          value={cohort.hcv_loss_ratio_override_approver || ""}
                          onChange={(e) => updateCohort(cohort.id, "hcv_loss_ratio_override_approver", e.target.value)}
                          style={inputStyle} />
                        <input type="text" placeholder="Reason for override"
                          value={cohort.hcv_loss_ratio_override_reason || ""}
                          onChange={(e) => updateCohort(cohort.id, "hcv_loss_ratio_override_reason", e.target.value)}
                          style={inputStyle} />
                      </div>
                    </div>
                  )}
                  {cohort.hcv_qualifier && (
                    <div style={{ fontSize: "0.74rem", color: "#5C6570", marginTop: "8px" }}>
                      <strong>Qualifier:</strong> {cohort.hcv_qualifier.label} · Coverage: {(cohort.hcv_qualifier.coverage * 100).toFixed(1)}%
                      {cohort.hcv_age_band && <span> · Age band: {cohort.hcv_age_band.replace(/_/g," ")} ({cohort.hcv_age_loading != null ? ((cohort.hcv_age_loading >= 0 ? "+" : "") + (cohort.hcv_age_loading * 100).toFixed(0) + "%") : ""})</span>}
                      {cohort.hcv_manufacturer_loading != null && <span> · Manufacturer: {((cohort.hcv_manufacturer_loading >= 0 ? "+" : "") + (cohort.hcv_manufacturer_loading * 100).toFixed(0) + "%")}</span>}
                    </div>
                  )}
                </div>
                )}

                {/* Trailer-specific fields */}
                {isTrailer && (
                <div style={{ marginTop: "14px", padding: "12px 14px", background: "#F1ECE0", borderRadius: "6px", borderLeft: "3px solid #14213D" }}>
                  <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "#14213D", marginBottom: "10px" }}>Trailer Underwriting</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                    <div>
                      <div style={{ fontSize: "0.72rem", color: "#5C6570", marginBottom: "4px" }}>Sum insured per trailer (R)</div>
                      <input type="number" min="0" step="10000"
                        value={cohort.trailer_sum_insured_per_unit === 0 ? "" : cohort.trailer_sum_insured_per_unit}
                        placeholder="0"
                        onFocus={(e) => setTimeout(() => e.target.select(), 0)}
                        onChange={(e) => updateCohort(cohort.id, "trailer_sum_insured_per_unit", e.target.value === "" ? 0 : Math.max(0, parseInt(e.target.value, 10)) || 0)}
                        onWheel={(e) => e.target.blur()}
                        style={inputStyle} />
                      {cohort.trailer_sum_insured_per_unit > 5000000 && (
                        <div style={{ fontSize: "0.72rem", color: "#B5762A", marginTop: "3px" }}>⚠ Sum insured per trailer exceeds R5m — verify.</div>
                      )}
                    </div>
                    <div>
                      <div style={{ fontSize: "0.72rem", color: "#5C6570", marginBottom: "4px" }}>Trailer type</div>
                      <select value={cohort.trailer_type || "tautliner"} onChange={(e) => updateCohort(cohort.id, "trailer_type", e.target.value)} style={inputStyle}>
                        <option value="tautliner">Tautliner / Curtainsider</option>
                        <option value="flatdeck">Flatdeck</option>
                        <option value="tanker">Tanker (non-hazmat)</option>
                        <option value="side_tipper">Side Tipper</option>
                        <option value="interlink">Interlink</option>
                        <option value="refrigerated">Refrigerated Trailer</option>
                        <option value="other">Other / Unspecified</option>
                      </select>
                    </div>
                  </div>
                  <div style={{ fontSize: "0.74rem", color: "#5C6570", marginTop: "8px" }}>
                    Base rate: 2.0% p.a. · Own damage excess: 10% min R15,000 · Theft/hijack: 15% min R7,500
                  </div>
                </div>
                )}

                {/* ORCA Underwriting Panel — GIT only */}
                {!isHcv && !isTrailer && cohort.asset_class !== "yellow_metal_plant" && cohort.asset_class !== "agricultural_equipment" && (
                <div
                  style={{
                    marginTop: "14px",
                    padding: "12px 14px",
                    background: "#F1ECE0",
                    borderRadius: "6px",
                    borderLeft: "3px solid #14213D",
                  }}
                >
                  <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "#14213D", marginBottom: "10px" }}>
                    ORCA Underwriting
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "10px", marginBottom: "10px" }}>
                    <label style={{ fontSize: "0.78rem", color: "#5C6570", display: "flex", alignItems: "center", gap: "6px" }}>
                      <input
                        type="checkbox"
                        checked={cohort.goods_is_new}
                        onChange={(e) => updateCohort(cohort.id, "goods_is_new", e.target.checked)}
                      />
                      New goods
                    </label>
                    <label style={{ fontSize: "0.78rem", color: "#5C6570", display: "flex", alignItems: "center", gap: "6px" }}>
                      <input
                        type="checkbox"
                        checked={cohort.goods_fully_enclosed_or_tarpaulin}
                        onChange={(e) => updateCohort(cohort.id, "goods_fully_enclosed_or_tarpaulin", e.target.checked)}
                      />
                      Fully enclosed / tarpaulin
                    </label>
                    <label style={{ fontSize: "0.78rem", color: "#5C6570", display: "flex", alignItems: "center", gap: "6px" }}>
                      <input
                        type="checkbox"
                        checked={cohort.goods_is_livestock}
                        onChange={(e) => updateCohort(cohort.id, "goods_is_livestock", e.target.checked)}
                      />
                      Livestock
                    </label>
                  </div>

                  {cohort.load_limit_per_vehicle >= ORCA_TRACKING_RULES.threshold_rand && (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "10px" }}>
                      <div>
                        <div style={{ fontSize: "0.7rem", color: "#5C6570", marginBottom: "4px" }}>
                          Tracking device vendor (required ≥R{ORCA_TRACKING_RULES.threshold_rand.toLocaleString()})
                        </div>
                        <input
                          type="text"
                          placeholder="e.g. Cartrack"
                          value={cohort.tracking_device_vendor}
                          onChange={(e) => updateCohort(cohort.id, "tracking_device_vendor", e.target.value)}
                          style={inputStyle}
                        />
                      </div>
                      <div>
                        <div style={{ fontSize: "0.7rem", color: "#5C6570", marginBottom: "4px" }}>Category</div>
                        <select
                          value={cohort.tracking_device_category}
                          onChange={(e) => updateCohort(cohort.id, "tracking_device_category", e.target.value)}
                          style={inputStyle}
                        >
                          <option value="">Select</option>
                          <option value="A">Category A</option>
                          <option value="C">Category C</option>
                          <option value="B">Category B (not approved)</option>
                        </select>
                      </div>
                    </div>
                  )}

                  <div style={{ fontSize: "0.74rem", color: "#5C6570", lineHeight: 1.6 }}>
                    <div>
                      <strong>Cover tier:</strong>{" "}
                      {computeUnderwritingStatus(cohort).coverTier.replace(/_/g, " ")}
                    </div>
                    <div>
                      <strong>Settlement basis:</strong>{" "}
                      {computeUnderwritingStatus(cohort).settlementBasis.replace(/_/g, " ")}
                    </div>
                    {cohort.load_limit_per_vehicle >= ORCA_TRACKING_RULES.threshold_rand && (
                      <div style={{ color: computeUnderwritingStatus(cohort).trackingStatus.met ? "#2D5016" : "#B23A2E" }}>
                        <strong>Tracking:</strong> {computeUnderwritingStatus(cohort).trackingStatus.reason}
                      </div>
                    )}
                    {computeUnderwritingStatus(cohort).exclusionCheck.status !== "standard" && (
                      <div style={{ color: "#B23A2E" }}>
                        <strong>Commodity flag:</strong>{" "}
                        {computeUnderwritingStatus(cohort).exclusionCheck.status === "absolute_exclusion"
                          ? "Absolute exclusion — not coverable"
                          : "Requires declaration & UW approval"}
                      </div>
                    )}
                  </div>
                </div>
                )}

                {/* ORCA Underwriting Panel — Plant / Yellow Metal */}
                {cohort.asset_class === "yellow_metal_plant" && (
                <div
                  style={{
                    marginTop: "14px",
                    padding: "12px 14px",
                    background: "#F1ECE0",
                    borderRadius: "6px",
                    borderLeft: "3px solid #14213D",
                  }}
                >
                  <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "#14213D", marginBottom: "10px" }}>
                    Plant / Yellow Metal — Data Source
                  </div>
                  <div style={{ marginBottom: "10px" }}>
                    <div style={{ fontSize: "0.72rem", color: "#5C6570", marginBottom: "4px" }}>Telematics data source</div>
                    <select
                      value={cohort.plant_data_source}
                      onChange={(e) => updateCohort(cohort.id, "plant_data_source", e.target.value)}
                      style={inputStyle}
                    >
                      <option value="oemOnly">OEM only (VisionLink / KOMTRAX / CareTrack — no SVR)</option>
                      <option value="oemSvr">OEM + insurance-approved SVR fitted</option>
                    </select>
                  </div>
                  <div style={{ fontSize: "0.74rem", color: "#5C6570", lineHeight: 1.6 }}>
                    <div><strong>Coverage:</strong> {cohort.plant_data_source === "oemSvr" ? "94.5% — Profile A eligible (0.70×)" : "60.2% — Profile B partial (1.40×)"}</div>
                    <div><strong>Base rate:</strong> 2.0% p.a. of declared machine value</div>
                    <div style={{ marginTop: "4px", color: "#8B6914", fontSize: "0.7rem" }}>
                      Note: OEM telematics gives location only — full theft credit requires an approved SVR unit alongside the OEM feed.
                    </div>
                  </div>
                </div>
                )}

                {/* ORCA Underwriting Panel — Agricultural Equipment */}
                {cohort.asset_class === "agricultural_equipment" && (
                <div
                  style={{
                    marginTop: "14px",
                    padding: "12px 14px",
                    background: "#F1ECE0",
                    borderRadius: "6px",
                    borderLeft: "3px solid #14213D",
                  }}
                >
                  <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "#14213D", marginBottom: "10px" }}>
                    Agricultural Equipment — Machine Type & Data Source
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "10px" }}>
                    <div>
                      <div style={{ fontSize: "0.72rem", color: "#5C6570", marginBottom: "4px" }}>Machine type</div>
                      <select
                        value={cohort.agri_machine_type}
                        onChange={(e) => updateCohort(cohort.id, "agri_machine_type", e.target.value)}
                        style={inputStyle}
                      >
                        <option value="combine">Combine harvester</option>
                        <option value="tractor">Tractor</option>
                        <option value="sprayer">Sprayer</option>
                      </select>
                    </div>
                    <div>
                      <div style={{ fontSize: "0.72rem", color: "#5C6570", marginBottom: "4px" }}>Telematics / fitment</div>
                      <select
                        value={cohort.agri_data_source}
                        onChange={(e) => updateCohort(cohort.id, "agri_data_source", e.target.value)}
                        style={inputStyle}
                      >
                        <option value="oemOnly">OEM only (no suppression, no SVR)</option>
                        <option value="fullFit">Full fit (fire suppression + SVR)</option>
                      </select>
                    </div>
                  </div>
                  <div style={{ fontSize: "0.74rem", color: "#5C6570", lineHeight: 1.6 }}>
                    <div><strong>Base rate:</strong> 1.6% p.a. of declared machine value</div>
                    <div style={{ marginTop: "4px", color: "#8B6914", fontSize: "0.7rem" }}>
                      Dual gate: both fire suppression AND SVR are required to clear the two hard gates and reach Profile A. Only a fully-fitted combine can reach Profile A (0.70×) — tractors and sprayers top out at Profile B upper (1.10×) even when fully fitted.
                    </div>
                  </div>
                </div>
                )}

                {/* Below-R50k override — GIT only */}
                {!isHcv && !isTrailer && needsOverride && (
                  <div
                    style={{
                      marginTop: "14px",
                      padding: "12px 14px",
                      background: "rgba(178,58,46,0.06)",
                      border: "1px solid #B23A2E",
                      borderRadius: "6px",
                    }}
                  >
                    <div style={{ fontSize: "0.82rem", fontWeight: 600, color: "#B23A2E", marginBottom: "6px" }}>
                      ⚠ Below-R50k Management Override
                    </div>
                    <div style={{ fontSize: "0.78rem", color: "#5C6570", marginBottom: "10px" }}>
                      Load limit R{cohort.load_limit_per_vehicle.toLocaleString()} is below the R50,000 minimum priceable band.
                      Enter a manual PVPM rate to override.
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                      <div>
                        <div style={{ fontSize: "0.72rem", color: "#5C6570", marginBottom: "4px" }}>Manual PVPM (R)</div>
                        <input
                          type="number"
                          min="0"
                          step="25"
                          placeholder="e.g. 200"
                          value={cohort.manual_override_pvpm || ""}
                          onFocus={(e) => setTimeout(() => e.target.select(), 0)}
                          onChange={(e) =>
                            updateCohort(
                              cohort.id,
                              "manual_override_pvpm",
                              e.target.value === "" ? null : Number(e.target.value)
                            )
                          }
                          onWheel={(e) => e.target.blur()}
                          style={{ ...inputStyle, borderColor: "#B23A2E" }}
                        />
                      </div>
                      <div>
                        <div style={{ fontSize: "0.72rem", color: "#5C6570", marginBottom: "4px" }}>Override approver</div>
                        <input
                          type="text"
                          placeholder="Approver name"
                          value={overrideApproverName}
                          onChange={(e) => setOverrideApproverName(e.target.value)}
                          style={{ ...inputStyle, borderColor: "#B23A2E" }}
                        />
                      </div>
                    </div>
                  </div>
                )}

                {/* Pricing breakdown (quotable cohorts) */}
                {!isReferred && (
                  <div
                    style={{
                      marginTop: "14px",
                      padding: "12px",
                      background: "#F9F7F3",
                      borderRadius: "4px",
                      fontFamily: "'IBM Plex Mono', monospace",
                      fontSize: "0.78rem",
                      color: "#5C6570",
                    }}
                  >
                    <div style={{ marginBottom: "6px" }}>
                      <strong style={{ color: "#14213D" }}>Pricing breakdown</strong>
                    </div>
                    {isPlantAgri ? (
                      <>
                        <div>Machine value per unit: R{Number(cohort.machine_value_per_unit || 0).toLocaleString()}</div>
                        <div>Base rate: {((cohort.base_rate || 0) * 100).toFixed(1)}% p.a.</div>
                        <div>Rating factor: {cohort.rating_factor?.toFixed(2)}x ({cohort.profile})</div>
                        <div>Annual per unit: R{cohort.annual_premium_per_unit?.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                        <div style={{ marginTop: "6px", borderTop: "1px dashed #D4C4B0", paddingTop: "6px" }}>
                          <strong>
                            {cohort.vehicle_count} units × R{cohort.annual_premium_per_unit?.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/yr
                            = R{cohort.cohort_monthly?.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/mo
                          </strong>
                          {cohort.min_premium_applied && (
                            <span style={{ color: "#B5762A", marginLeft: "8px" }}>(min R5,000/yr applied)</span>
                          )}
                        </div>
                        <div>Annual: R{cohort.cohort_annual?.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                      </>
                    ) : isTrailer ? (
                      <>
                        <div>Base rate: {(TRAILER_BASE_RATE * 100).toFixed(1)}% p.a. · Own damage: 10% min R15,000 · Theft/hijack: 15% min R7,500</div>
                        {cohort.pricing_mode === "per_vehicle" && cohort.priced_trailers?.length > 0 ? (
                          <div style={{ marginTop: "8px", overflowX: "auto" }}>
                            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.74rem" }}>
                              <thead>
                                <tr style={{ background: "#14213D", color: "#FAF7F0" }}>
                                  {["Reg","Make","Model","Year","Sum Insured","Monthly","Annual"].map(h => (
                                    <th key={h} style={{ padding: "4px 6px", textAlign: h === "Sum Insured" || h === "Monthly" || h === "Annual" ? "right" : "left" }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {cohort.priced_trailers.map((v, i) => (
                                  <tr key={i} style={{ background: i % 2 === 0 ? "#fff" : "#F5F7FA" }}>
                                    <td style={{ padding: "3px 6px" }}>{v.registration}</td>
                                    <td style={{ padding: "3px 6px" }}>{v.make}</td>
                                    <td style={{ padding: "3px 6px" }}>{v.model}</td>
                                    <td style={{ padding: "3px 6px" }}>{v.year}</td>
                                    <td style={{ padding: "3px 6px", textAlign: "right" }}>R{(v.insured_value || 0).toLocaleString("en-ZA")}</td>
                                    <td style={{ padding: "3px 6px", textAlign: "right", fontWeight: 600 }}>R{v.monthly?.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                                    <td style={{ padding: "3px 6px", textAlign: "right" }}>R{v.annual?.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                                  </tr>
                                ))}
                              </tbody>
                              <tfoot>
                                <tr style={{ background: "#E8EDF5", fontWeight: 700 }}>
                                  <td colSpan={4} style={{ padding: "4px 6px" }}>TOTAL ({cohort.priced_trailers.length} trailers)</td>
                                  <td style={{ padding: "4px 6px", textAlign: "right" }}>R{cohort.trailer_total_si?.toLocaleString("en-ZA")}</td>
                                  <td style={{ padding: "4px 6px", textAlign: "right" }}>R{cohort.cohort_monthly?.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/mo</td>
                                  <td style={{ padding: "4px 6px", textAlign: "right" }}>R{cohort.cohort_annual?.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/yr</td>
                                </tr>
                              </tfoot>
                            </table>
                            {cohort.min_premium_applied && <div style={{ color: "#B5762A", fontSize: "0.74rem", marginTop: "4px" }}>(min R5,000/yr applied)</div>}
                          </div>
                        ) : (
                          <>
                            <div>Total sum insured: R{cohort.trailer_total_si?.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                            <div style={{ marginTop: "6px", borderTop: "1px dashed #D4C4B0", paddingTop: "6px" }}>
                              <strong>Annual: R{cohort.cohort_annual?.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · Monthly: R{cohort.cohort_monthly?.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/mo</strong>
                              {cohort.min_premium_applied && <span style={{ color: "#B5762A", marginLeft: "8px" }}>(min R5,000/yr applied)</span>}
                            </div>
                          </>
                        )}
                      </>
                    ) : isHcv ? (
                      <>
                        <div>Base rate: {(HCV_BASE_RATE * 100).toFixed(1)}% p.a. · Data-source qualifier: {cohort.hcv_qualifier?.factor?.toFixed(2)}× ({cohort.hcv_qualifier?.label})</div>
                        {cohort.hcv_loss_ratio_override_approver && (
                          <div style={{ color: "#B5762A" }}>Loss ratio override: approved by {cohort.hcv_loss_ratio_override_approver}</div>
                        )}
                        {cohort.pricing_mode === "per_vehicle" && cohort.priced_vehicles?.length > 0 ? (
                          <div style={{ marginTop: "8px", overflowX: "auto" }}>
                            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.74rem" }}>
                              <thead>
                                <tr style={{ background: "#14213D", color: "#FAF7F0" }}>
                                  {["Reg","Make","Model","Year","Sum Insured","Mfr","Age Band","Monthly","Annual"].map(h => (
                                    <th key={h} style={{ padding: "4px 6px", textAlign: h === "Sum Insured" || h === "Monthly" || h === "Annual" ? "right" : "left", whiteSpace: "nowrap" }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {cohort.priced_vehicles.map((v, i) => (
                                  <tr key={i} style={{ background: i % 2 === 0 ? "#fff" : "#F5F7FA" }}>
                                    <td style={{ padding: "3px 6px" }}>{v.registration}</td>
                                    <td style={{ padding: "3px 6px" }}>{v.make}</td>
                                    <td style={{ padding: "3px 6px", maxWidth: "120px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.model}</td>
                                    <td style={{ padding: "3px 6px" }}>{v.year}</td>
                                    <td style={{ padding: "3px 6px", textAlign: "right" }}>R{(v.insured_value || 0).toLocaleString("en-ZA")}</td>
                                    <td style={{ padding: "3px 6px" }}>{v.mfr_loading != null ? ((v.mfr_loading >= 0 ? "+" : "") + (v.mfr_loading * 100).toFixed(0) + "%") : ""}</td>
                                    <td style={{ padding: "3px 6px", whiteSpace: "nowrap" }}>{v.age_band?.replace(/_/g, " ")} {v.age_loading != null ? ((v.age_loading >= 0 ? "+" : "") + (v.age_loading * 100).toFixed(0) + "%") : ""}</td>
                                    <td style={{ padding: "3px 6px", textAlign: "right", fontWeight: 600 }}>R{v.monthly?.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                                    <td style={{ padding: "3px 6px", textAlign: "right" }}>R{v.annual?.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                                  </tr>
                                ))}
                              </tbody>
                              <tfoot>
                                <tr style={{ background: "#E8EDF5", fontWeight: 700 }}>
                                  <td colSpan={4} style={{ padding: "4px 6px", fontSize: "0.75rem" }}>TOTAL ({cohort.priced_vehicles.length} vehicles)</td>
                                  <td style={{ padding: "4px 6px", textAlign: "right" }}>R{cohort.total_sum_insured?.toLocaleString("en-ZA")}</td>
                                  <td colSpan={2} />
                                  <td style={{ padding: "4px 6px", textAlign: "right" }}>R{cohort.cohort_monthly?.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/mo</td>
                                  <td style={{ padding: "4px 6px", textAlign: "right" }}>R{cohort.cohort_annual?.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/yr</td>
                                </tr>
                              </tfoot>
                            </table>
                            {cohort.min_premium_applied && <div style={{ color: "#B5762A", fontSize: "0.74rem", marginTop: "4px" }}>(min R5,000/yr applied)</div>}
                          </div>
                        ) : (
                          <>
                            <div>Total sum insured: R{cohort.total_sum_insured?.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                            <div>Manufacturer loading: {cohort.hcv_manufacturer_loading != null ? ((cohort.hcv_manufacturer_loading >= 0 ? "+" : "") + (cohort.hcv_manufacturer_loading * 100).toFixed(0) + "%") : "0%"}</div>
                            <div>Age band: {cohort.hcv_age_band?.replace(/_/g, " ")} — {cohort.hcv_age_loading != null ? ((cohort.hcv_age_loading >= 0 ? "+" : "") + (cohort.hcv_age_loading * 100).toFixed(0) + "%") : "0%"}</div>
                            <div style={{ marginTop: "6px", borderTop: "1px dashed #D4C4B0", paddingTop: "6px" }}>
                              <strong>Annual: R{cohort.cohort_annual?.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · Monthly: R{cohort.cohort_monthly?.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/mo</strong>
                              {cohort.min_premium_applied && <span style={{ color: "#B5762A", marginLeft: "8px" }}>(min R5,000/yr applied)</span>}
                            </div>
                          </>
                        )}
                      </>
                    ) : (
                      <>
                        <div>Base PVPM: R{cohort.base_pvpm?.toFixed(2)}</div>
                        <div>
                          Loadings: geo {cohort.loadings?.geo?.toFixed(2)}x · claims {cohort.loadings?.claims?.toFixed(2)}x
                          · age {cohort.loadings?.age?.toFixed(2)}x · night {cohort.loadings?.night?.toFixed(2)}x
                          · border {cohort.loadings?.cross?.toFixed(2)}x · cover {cohort.loadings?.restricted?.toFixed(2)}x
                        </div>
                        <div>Loaded PVPM: R{cohort.loaded_pvpm?.toFixed(2)}</div>
                        <div>
                          IoT adjustment: {(cohort.iot_credit?.total_credit * 100).toFixed(0)}%
                          {cohort.iot_credit?.capped ? " (capped at -40%)" : ""}
                        </div>
                        <div>Final PVPM: R{cohort.final_pvpm?.toFixed(2)}</div>
                        <div style={{ marginTop: "6px", borderTop: "1px dashed #D4C4B0", paddingTop: "6px" }}>
                          <strong>
                            R{cohort.final_pvpm?.toFixed(2)} × {cohort.vehicle_count} vehicles = R
                            {cohort.cohort_monthly?.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            /mo
                          </strong>
                          {cohort.min_premium_applied && (
                            <span style={{ color: "#B5762A", marginLeft: "8px" }}>(min R5,000/yr applied)</span>
                          )}
                          {cohort.override_applied && (
                            <span style={{ color: "#B23A2E", marginLeft: "8px" }}>(manual override)</span>
                          )}
                        </div>
                        <div>
                          Annual: R
                          {cohort.cohort_annual?.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Referral reason (referred cohorts) */}
                {isReferred && (
                  <div
                    style={{
                      marginTop: "14px",
                      padding: "12px",
                      background: "rgba(178,58,46,0.04)",
                      borderRadius: "4px",
                      fontSize: "0.82rem",
                      color: "#B23A2E",
                    }}
                  >
                    {cohort.referral_reason}
                  </div>
                )}

                {/* Remove button */}
                {cohorts.length > 1 && (
                  <div style={{ marginTop: "12px", textAlign: "right" }}>
                    <button
                      className="tx-btn"
                      onClick={() => removeCohort(cohort.id)}
                      style={{
                        ...tabBtnStyle,
                        fontSize: "0.72rem",
                        padding: "4px 12px",
                        color: "#B23A2E",
                        borderColor: "#B23A2E",
                        background: "transparent",
                      }}
                    >
                      Remove cohort
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Claims History Upload */}
      <div style={{ marginTop: "24px", padding: "16px 18px", background: "#F5F7FA", borderRadius: "8px", border: "1px solid #E0E6EE" }}>
        <div style={{ fontSize: "0.78rem", fontWeight: 700, color: "#14213D", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "10px" }}>Claims History Upload</div>
        <div style={{ fontSize: "0.82rem", color: "#5C6570", marginBottom: "12px" }}>
          Upload a 3-year claims history (PDF or Excel). Loss ratios are extracted per year, allocated to cohorts, and the 65% referral gate applies automatically.
        </div>
        {(claimsStatus === "idle" || claimsStatus === "error") && (
          <div
            onDragOver={e => { e.preventDefault(); setClaimsDragOver(true); }}
            onDragLeave={() => setClaimsDragOver(false)}
            onDrop={e => { e.preventDefault(); setClaimsDragOver(false); processClaimsFile(e.dataTransfer.files[0]); }}
            onClick={() => claimsInputRef.current?.click()}
            style={{ border: `2px dashed ${claimsDragOver ? "#14213D" : "#C8D0DC"}`, borderRadius: "6px", padding: "20px", textAlign: "center", cursor: "pointer", background: claimsDragOver ? "#E8EDF5" : "#fff", marginBottom: "8px" }}
          >
            <div style={{ fontSize: "0.88rem", color: "#5C6570" }}>Drop claims history PDF or Excel here, or click to upload</div>
            <input ref={claimsInputRef} type="file" accept=".pdf,.xlsx,.xls,.csv" style={{ display: "none" }} onChange={e => processClaimsFile(e.target.files[0])} />
          </div>
        )}
        {claimsError && <div style={{ color: "#C0392B", fontSize: "0.82rem", marginBottom: "8px" }}>{claimsError}</div>}
        {(claimsStatus === "reading" || claimsStatus === "extracting") && (
          <div style={{ color: "#14213D", fontSize: "0.85rem", padding: "12px" }}>
            {claimsStatus === "reading" ? "Reading document..." : "Extracting claims data — this takes a few seconds..."}
          </div>
        )}
        {claimsStatus === "done" && claimsStepA && !claimsApplied && (
          <div style={{ marginTop: "8px" }}>
            <div style={{ fontSize: "0.82rem", fontWeight: 600, color: "#14213D", marginBottom: "8px" }}>Step A — Review extracted claims data</div>
            {claimsStepA.extraction_notes && (
              <div style={{ fontSize: "0.76rem", color: "#B5762A", marginBottom: "10px", padding: "8px", background: "#FFF8EE", borderRadius: "4px" }}>{claimsStepA.extraction_notes}</div>
            )}
            {claimsStepA.years && claimsStepA.years.length > 0 && (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.80rem", marginBottom: "12px" }}>
                <thead>
                  <tr style={{ background: "#14213D", color: "#FAF7F0" }}>
                    {["Year","Premium (R)","Claims (R)","Loss Ratio %","Claims #"].map(h => <th key={h} style={{ padding: "6px 10px", textAlign: h === "Year" ? "left" : "right" }}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {claimsStepA.years.map((y, i) => (
                    <tr key={y.year} style={{ background: i % 2 === 0 ? "#fff" : "#F5F7FA" }}>
                      <td style={{ padding: "5px 10px" }}>{y.year}</td>
                      <td style={{ padding: "5px 10px", textAlign: "right" }}>{y.premium != null ? `R${Number(y.premium).toLocaleString("en-ZA")}` : "—"}</td>
                      <td style={{ padding: "5px 10px", textAlign: "right" }}>{y.claims != null ? `R${Number(y.claims).toLocaleString("en-ZA")}` : "—"}</td>
                      <td style={{ padding: "5px 10px", textAlign: "right", color: (y.loss_ratio_pct || 0) > 65 ? "#C0392B" : "#1A6B3C", fontWeight: 600 }}>
                        {y.loss_ratio_pct != null ? `${Number(y.loss_ratio_pct).toFixed(1)}%` : "—"}
                      </td>
                      <td style={{ padding: "5px 10px", textAlign: "right" }}>{y.claim_count ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div style={{ fontSize: "0.82rem", fontWeight: 600, color: "#14213D", marginBottom: "6px" }}>Step B — Allocate claims to cohorts (% split, must total 100%)</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 80px", gap: "6px", alignItems: "center", marginBottom: "10px" }}>
              {cohorts.map(c => (
                <React.Fragment key={c.id}>
                  <div style={{ fontSize: "0.82rem", color: "#14213D" }}>{c.label} — {c.asset_class?.replace(/_/g," ")}</div>
                  <input type="number" min={0} max={100} value={manualSplit[c.id] ?? ""} onChange={e => setManualSplit(prev => ({ ...prev, [c.id]: Number(e.target.value) }))} placeholder="0"
                    style={{ padding: "5px 8px", border: "1px solid #C8D0DC", borderRadius: "4px", textAlign: "right", fontSize: "0.85rem" }} />
                </React.Fragment>
              ))}
            </div>
            {(() => {
              const total = Object.values(manualSplit).reduce((s, v) => s + (v || 0), 0);
              return (
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <div style={{ fontSize: "0.78rem", color: Math.abs(total - 100) < 0.1 ? "#1A6B3C" : "#C0392B" }}>Total: {total}% {Math.abs(total - 100) < 0.1 ? "✓" : "(must equal 100%)"}</div>
                  <button disabled={Math.abs(total - 100) > 0.1} onClick={() => applyClaimsToCohorts(manualSplit)}
                    style={{ background: Math.abs(total - 100) < 0.1 ? "#14213D" : "#C8D0DC", color: "#fff", border: "none", borderRadius: "5px", padding: "8px 20px", fontSize: "0.85rem", fontWeight: 600, cursor: Math.abs(total - 100) < 0.1 ? "pointer" : "not-allowed" }}>
                    Confirm & Apply to Cohorts
                  </button>
                  <button onClick={() => { setClaimsStatus("idle"); setClaimsStepA(null); setManualSplit({}); }}
                    style={{ background: "transparent", border: "1px solid #C8D0DC", borderRadius: "5px", padding: "8px 14px", fontSize: "0.82rem", cursor: "pointer", color: "#5C6570" }}>Re-upload</button>
                </div>
              );
            })()}
          </div>
        )}
        {claimsApplied && (
          <div style={{ padding: "10px 14px", background: "#E8F5EE", borderRadius: "6px", border: "1px solid #1A6B3C", marginTop: "8px" }}>
            <div style={{ fontSize: "0.82rem", fontWeight: 600, color: "#1A6B3C", marginBottom: "4px" }}>✓ Claims history applied to cohorts</div>
            <div style={{ fontSize: "0.78rem", color: "#5C6570" }}>Loss ratios applied. Cohorts exceeding 65% will show a REFER gate.</div>
            <button onClick={() => { setClaimsStatus("idle"); setClaimsStepA(null); setManualSplit({}); setClaimsApplied(false); }}
              style={{ marginTop: "8px", background: "transparent", border: "1px solid #C8D0DC", borderRadius: "4px", padding: "5px 12px", fontSize: "0.78rem", cursor: "pointer", color: "#5C6570" }}>
              Upload new claims history
            </button>
          </div>
        )}
      </div>

      {/* Shared loadings summary */}
      <div style={{ marginTop: "24px" }}>
        <div style={sectionLabelStyle}>Shared loadings (from Fleet Information)</div>
        <div
          style={{
            marginTop: "10px",
            padding: "12px",
            background: "#F1ECE0",
            borderRadius: "6px",
            fontSize: "0.78rem",
            color: "#5C6570",
            fontFamily: "'IBM Plex Mono', monospace",
          }}
        >
          <div>
            Geography: {sharedFields.geographic_zone.replace(/_/g, " ")} · Claims: {sharedFields.claims_history.replace(/_/g, " ")}
            · Age: {sharedFields.fleet_age.replace(/_/g, " ")} · Night: {sharedFields.night_ops.replace(/_/g, " ")}
            · Border: {sharedFields.cross_border.replace(/_/g, " ")} · Cover: {sharedFields.cover_type.replace(/_/g, " ")}
          </div>
          <div style={{ marginTop: "4px" }}>
            HCV qualifier:{" "}
            <span style={{ color: "#5C6570", fontStyle: "italic" }}>
              Set per cohort in HCV Underwriting panel
            </span>
          </div>
          <div style={{ marginTop: "4px" }}>
            IoT devices: {sharedFields.iot_devices_fitted.length > 0 ? sharedFields.iot_devices_fitted.join(", ") : "none"}
            {sharedFields.cargosnap_fitted ? " · CargoSnap ✓" : ""}
            {sharedFields.cvtscpi_rmp_tier !== "none" ? ` · RMP: ${sharedFields.cvtscpi_rmp_tier}` : ""}
          </div>
          <div style={{ marginTop: "6px", fontSize: "0.72rem", color: "#999" }}>
            Edit these on the Fleet Information tab — they apply to all cohorts.
          </div>
        </div>
      </div>
    </div>
  );
}



