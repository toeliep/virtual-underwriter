import React, { useState, useMemo, useCallback } from "react";
import {
  checkTrackingGate,
  determineGitCoverTier,
  ORCA_GIT_SETTLEMENT_BASIS,
  classifyExclusion,
  ORCA_TRACKING_RULES,
} from "./orcaUnderwritingRules.js";

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
};

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

function priceCohort(cohort, sharedFields) {
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

export default function MultiCohortView({ sharedFleetInfo }) {
  const shared = sharedFleetInfo || {};
  const [cohorts, setCohorts] = useState(() => [makeCohort(0, shared)]);
  const [expandedCohort, setExpandedCohort] = useState(0);
  const [overrideApproverName, setOverrideApproverName] = useState("");

  const addCohort = useCallback(() => {
    setCohorts((prev) => [...prev, makeCohort(prev.length, shared)]);
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
  }), [shared]);

  // Price all cohorts
  const pricedCohorts = useMemo(() => {
    return cohorts.map((c) => {
      const priced = priceCohort(c, sharedFields);
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
            <div style={statValue}>{fleetSummary.totalVehicles}</div>
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
        const needsOverride = isReferred && cohort.load_limit_per_vehicle < GIT_LOAD_LIMIT_MIN_RAND;

        return (
          <div
            key={cohort.id}
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
                  R{(cohort.load_limit_per_vehicle || 0).toLocaleString()} load limit
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
                  <div style={{ fontSize: "0.72rem", color: "#B5762A" }}>
                    {cohort.multiplier.toFixed(2)}x · R{cohort.final_pvpm.toFixed(2)}/veh
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
                  <div>
                    <div style={{ fontSize: "0.72rem", color: "#5C6570", marginBottom: "4px" }}>Vehicle count</div>
                    <input
                      type="number"
                      min="0"
                      value={cohort.vehicle_count}
                      onFocus={(e) => setTimeout(() => e.target.select(), 0)}
                      onChange={(e) => updateCohort(cohort.id, "vehicle_count", Number(e.target.value))}
                      onWheel={(e) => e.target.blur()}
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: "0.72rem", color: "#5C6570", marginBottom: "4px" }}>Load limit per vehicle (R)</div>
                    <input
                      type="number"
                      min="0"
                      step="10000"
                      value={cohort.load_limit_per_vehicle}
                      onFocus={(e) => setTimeout(() => e.target.select(), 0)}
                      onChange={(e) => updateCohort(cohort.id, "load_limit_per_vehicle", Number(e.target.value))}
                      onWheel={(e) => e.target.blur()}
                      style={inputStyle}
                    />
                  </div>
                </div>

                {/* ORCA Underwriting Panel */}
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

                {/* Below-R50k override */}
                {needsOverride && (
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
                    <div>Base PVPM: R{cohort.base_pvpm?.toFixed(2)}</div>
                    <div>
                      Loadings: geo {cohort.loadings.geo.toFixed(2)}x · claims {cohort.loadings.claims.toFixed(2)}x
                      · age {cohort.loadings.age.toFixed(2)}x · night {cohort.loadings.night.toFixed(2)}x
                      · border {cohort.loadings.cross.toFixed(2)}x · cover {cohort.loadings.restricted.toFixed(2)}x
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
