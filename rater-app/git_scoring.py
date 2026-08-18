"""
GIT Scientific Rating Engine
-----------------------------
Deterministic scoring logic for Goods-in-Transit (GIT) cover, derived from:
  - GIT_PVPM_Matrix_65LR.xlsx (PVPM formula, commodity factors, Motorworld case study)
  - GIT_Rating_Methodology.xlsx (peril loading, commodity loading, IoT credits, claims basis)

Confirmed by Frans Prinsloo, 3 July 2026:
  - GIT does NOT get a score-based auto-decline like HCV.
  - Instead, cover is subject to a fixed, mandatory security requirement: CV+TS+CPI
    RMP 1 (Top Lock) is a non-negotiable precondition for binding cover on high-value
    cargo / RMP-1-scoped fleets. This mirrors the existing pattern where GPS is already
    mandatory for Theft/Hijack exposure in the IoT credit schedule below.

PVPM formula verified against the Motorworld case study to the exact rand:
  PVPM = base_monthly_rate x commodity_factor x all_risks_peril_blend x load_limit
  0.0005925 x 8.24 x 2.00 x 1,500,000 = R14,646.60  (matches workbook exactly)

This module intentionally does NOT call an LLM anywhere. Every number here is a
literal port of Frans's workbooks or an explicit rule he confirmed.
"""

from dataclasses import dataclass, field
from typing import Optional


# ---------------------------------------------------------------------------
# Constants — verified against GIT_PVPM_Matrix_65LR.xlsx
# ---------------------------------------------------------------------------

BASE_ANNUAL_RATE = 0.00711          # 0.711% p.a. minimum base rate, 65% LR calibrated
BASE_MONTHLY_RATE = BASE_ANNUAL_RATE / 12   # 0.0005925
ALL_RISKS_PERIL_BLEND = 2.00        # confirmed multiplier reproducing the Section A matrix exactly

# Commodity loading factors — cross-verified between GIT_PVPM_Matrix_65LR.xlsx
# (Section A, back-calculated) and GIT_Rating_Methodology.xlsx Module 2 (claims-derived).
# Where a commodity appears in both with the same figure, that figure is used.
COMMODITY_FACTORS = {
    "coal_mining_bulk": 0.55,
    "agricultural_grain": 0.98,       # matches "Food / Grain" in Rating Factors (0.98)
    "general_cargo": 1.00,            # base/benchmark commodity
    "building_materials": 1.10,
    "timber_paper": 1.15,
    "refrigerated_goods": 1.35,
    "machinery_equipment": 1.48,      # matches Rating Factors exactly
    "automotive_parts": 1.65,
    "metals_steel_chrome": 2.16,      # matches Rating Factors exactly
    "pharmaceuticals": 2.50,
    "alcohol_beverages": 2.83,        # matches Rating Factors exactly
    "fuel_petroleum": 2.96,           # matches Rating Factors "Fuel & Chemicals" exactly
    "electronics_tech": 3.20,
    "fmcg_retail_general": 5.00,
    "fmcg_branded_high_risk": 8.24,   # matches Rating Factors "FMCG / Retail" exactly; this is the
                                      # Motorworld/CCBSA-type band, not general FMCG
}

# Peril loading factors — GIT_Rating_Methodology.xlsx Module 1 (claims-derived).
# Base = Accidental Damage (1.00). Not yet wired into PVPM_FLEET calculation below;
# the PVPM matrix formula already implicitly assumes an "All Risks" blend (2.00x) that
# covers all perils together. Kept here for future peril-specific quoting if Frans
# wants per-peril breakdowns rather than an All Risks blend. OPEN ITEM — confirm with
# Frans whether/how these should combine with the All Risks blend rather than duplicate it.
PERIL_LOADING_FACTORS = {
    "theft": 4.09,
    "accidental_damage": 1.00,
    "load_shifting": 1.31,
    "spillage": 2.49,
    "hijacked": 2.19,
    "accident": 0.74,
    "water_damage": 0.98,
    "fire_explosion": 1.33,
}

# Additional multiplier loadings — GIT_PVPM_Matrix_65LR.xlsx, PVPM Fleet Calculator tab
GEOGRAPHIC_ZONE_LOADING = {"western_cape": 1.00, "medium_risk": 1.15, "gauteng_high_risk": 1.30}
CLAIMS_HISTORY_LOADING = {"clean": 1.00, "one_claim": 1.15}  # per-claim step beyond 1 not specified; escalate cautiously
FLEET_AGE_LOADING = {"new": 1.00, "over_10yr": 1.15}
NIGHT_OPS_LOADING = {"under_30pct": 1.00, "over_30pct": 1.20}
CROSS_BORDER_LOADING = {"local": 1.00, "sadc": 1.25}

# IoT device credits — GIT_Rating_Methodology.xlsx Module 3, verified exact figures.
IOT_CREDITS = {
    "gps_realtime_tracking": -0.15,
    "geofencing_alerting": -0.10,
    "driver_behaviour_monitoring": -0.12,
    "fatigue_drowsiness_sensor": -0.08,
    "cargo_seal_door_sensors": -0.10,
    "temperature_humidity_logger": -0.08,
    "load_weight_tilt_sensor": -0.10,
    "panic_button_armed_response": -0.05,
    "dashcam_front_rear": -0.05,
}
NO_IOT_PENALTY = 0.20          # applied if zero IoT devices are fitted
MAX_IOT_CREDIT = -0.40         # cap confirmed in PVPM Fleet Calculator

# Proposed additions (3 July 2026 working session) — NOT yet confirmed by Frans as final
# percentages, but the RMP1 mandatory mechanism itself IS confirmed.
PROPOSED_CARGOSNAP_CREDIT = -0.08
PROPOSED_CVTSCPI_RMP_CREDITS = {
    "none": 0.0,
    "rmp1_top_lock": -0.10,
    "rmp2_cable_lock": -0.15,
    "rmp3_tracktag": -0.20,
}


@dataclass
class FleetInput:
    fleet_name: str
    vehicle_count: int
    load_limit_per_vehicle: float
    commodity_type: str                 # key into COMMODITY_FACTORS
    geographic_zone: str = "western_cape"
    claims_history: str = "clean"
    fleet_age: str = "new"
    night_ops: str = "under_30pct"
    cross_border: str = "local"
    iot_devices_fitted: list = field(default_factory=list)   # keys into IOT_CREDITS
    cargosnap_fitted: bool = False
    cvtscpi_rmp_tier: str = "none"       # none / rmp1_top_lock / rmp2_cable_lock / rmp3_tracktag
    is_high_value_cargo: bool = False    # gates CV+TS+CPI eligibility, per Frans's RMP-1-only sign-off
    is_rmp1_scoped: bool = False         # gates CV+TS+CPI eligibility, per Frans's RMP-1-only sign-off


def compute_iot_credit_stack(f: FleetInput) -> dict:
    """Sums applicable IoT credits, capped at -40%. Applies +20% penalty if none fitted."""
    if not f.iot_devices_fitted and not f.cargosnap_fitted and f.cvtscpi_rmp_tier == "none":
        return {"total_credit": NO_IOT_PENALTY, "detail": "No IoT devices fitted — unmitigated risk"}

    total = 0.0
    detail = []
    for device in f.iot_devices_fitted:
        if device in IOT_CREDITS:
            total += IOT_CREDITS[device]
            detail.append(f"{device}: {IOT_CREDITS[device]:.0%}")
    if f.cargosnap_fitted:
        total += PROPOSED_CARGOSNAP_CREDIT
        detail.append(f"cargosnap (proposed): {PROPOSED_CARGOSNAP_CREDIT:.0%}")
    if f.cvtscpi_rmp_tier != "none":
        credit = PROPOSED_CVTSCPI_RMP_CREDITS.get(f.cvtscpi_rmp_tier, 0.0)
        total += credit
        detail.append(f"cvtscpi_{f.cvtscpi_rmp_tier} (proposed): {credit:.0%}")

    capped = max(total, MAX_IOT_CREDIT)  # more negative than cap gets floored at cap
    return {"total_credit": capped, "uncapped": total, "detail": detail,
             "capped": capped != total}


def check_mandatory_security_requirement(f: FleetInput) -> dict:
    """
    Per Frans's sign-off (3 July 2026): GIT does not auto-decline on score. Instead,
    high-value cargo / RMP-1-scoped fleets cannot bind cover without CV+TS+CPI RMP 1
    (Top Lock) fitted, at minimum. This is a hard precondition, not a soft credit.
    """
    in_scope = f.is_high_value_cargo and f.is_rmp1_scoped
    if not in_scope:
        return {"in_scope": False, "mandatory_met": True,
                "note": "Fleet outside high-value/RMP-1 scope — no mandatory requirement applies"}

    tiers_meeting_minimum = {"rmp1_top_lock", "rmp2_cable_lock", "rmp3_tracktag"}
    mandatory_met = f.cvtscpi_rmp_tier in tiers_meeting_minimum
    return {
        "in_scope": True,
        "mandatory_met": mandatory_met,
        "note": ("RMP 1 minimum satisfied" if mandatory_met else
                 "COVER CANNOT BIND — high-value/RMP-1-scoped fleet without minimum "
                 "CV+TS+CPI RMP 1 (Top Lock) fitted"),
    }


def compute_pvpm(f: FleetInput) -> dict:
    """
    Core PVPM formula, verified against the Motorworld case study to the exact rand:
    0.0005925 x 8.24 x 2.00 x 1,500,000 = R14,646.60
    """
    commodity_factor = COMMODITY_FACTORS.get(f.commodity_type)
    if commodity_factor is None:
        return {"error": f"Unknown commodity_type: {f.commodity_type}"}

    base_pvpm = BASE_MONTHLY_RATE * commodity_factor * ALL_RISKS_PERIL_BLEND * f.load_limit_per_vehicle

    geo = GEOGRAPHIC_ZONE_LOADING.get(f.geographic_zone, 1.00)
    claims = CLAIMS_HISTORY_LOADING.get(f.claims_history, 1.00)
    age = FLEET_AGE_LOADING.get(f.fleet_age, 1.00)
    night = NIGHT_OPS_LOADING.get(f.night_ops, 1.00)
    cross = CROSS_BORDER_LOADING.get(f.cross_border, 1.00)

    loaded_pvpm = base_pvpm * geo * claims * age * night * cross

    iot = compute_iot_credit_stack(f)
    iot_adjustment = loaded_pvpm * iot["total_credit"]
    final_pvpm = loaded_pvpm + iot_adjustment

    security = check_mandatory_security_requirement(f)

    total_monthly_premium = final_pvpm * f.vehicle_count if security["mandatory_met"] else None

    return {
        "fleet_name": f.fleet_name,
        "base_pvpm": round(base_pvpm, 2),
        "loaded_pvpm": round(loaded_pvpm, 2),
        "iot_credit": iot,
        "final_pvpm": round(final_pvpm, 2),
        "vehicle_count": f.vehicle_count,
        "total_monthly_premium": round(total_monthly_premium, 2) if total_monthly_premium is not None else None,
        "annual_premium": round(total_monthly_premium * 12, 2) if total_monthly_premium is not None else None,
        "mandatory_security": security,
        "verdict": "QUOTABLE" if security["mandatory_met"] else "CANNOT BIND — mandatory security requirement not met",
    }