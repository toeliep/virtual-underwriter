"""
GIT Scientific Rating Engine
PVPM formula verified: 0.0005925 x 8.24 x 2.00 x 1500000 = R14646.60
Frans Prinsloo confirmed: no score-based auto-decline. Mandatory CV+TS+CPI RMP1 for high-value cargo.

v2 additions (confirmed with Toelie, based on Hollard Trucking Underwriting Guide & Mandates V1
and Merx HCV Goods in Transit V3 2017 wording):
  - Minimum annual premium floor: R5,000/policy (matches Hollard GIT minimum)
  - Regional load-limit referral: western_cape > R1,500,000 (Cape Town); gauteng_high_risk/medium_risk
    > R1,000,000 (JHB/KZN) -> REFER
  - Loss ratio > 65% -> REFER (matches Hollard referral rule 4.3)
  - Restricted cover tier: 80% of All Risks premium (Fire/Collision/Overturning/Theft-Following-Hijack),
    75% of All Risks premium (Fire/Collision/Overturning only) - matches Hollard/Merx wording
  - Excluded-commodity referral: any commodity on Hollard's GIT exclusion list is automatically
    REFERred to management (no premium calculated) rather than priced or auto-declined, since the
    correct security tier depends on the physical form/subtype being transported (e.g. copper ore
    vs refined copper) which requires case-by-case research
"""
from dataclasses import dataclass, field

BASE_ANNUAL_RATE = 0.00711
BASE_MONTHLY_RATE = BASE_ANNUAL_RATE / 12
ALL_RISKS_PERIL_BLEND = 2.00

COMMODITY_FACTORS = {
    "coal_mining_bulk": 0.55,
    "agricultural_grain": 0.98,
    "general_cargo": 1.00,
    "building_materials": 1.10,
    "timber_paper": 1.15,
    "refrigerated_goods": 1.35,
    "machinery_equipment": 1.48,
    "automotive_parts": 1.65,
    "metals_steel_chrome": 2.16,
    "pharmaceuticals": 2.50,
    "alcohol_beverages": 2.83,
    "fuel_petroleum": 2.96,
    "electronics_tech": 3.20,
    "fmcg_retail_general": 5.00,
    "fmcg_branded_high_risk": 8.24,
}

# Commodities appearing in Hollard's GIT General Exclusions (Section F) that TelematiX has
# chosen to make available for referral rather than hard-excluding or auto-pricing. These are
# NOT priced automatically - the correct security tier depends on the specific form/subtype
# being transported (e.g. copper ore & aggregate vs refined copper require different minimum
# locks), which requires case-by-case management research. No commodity factor is assigned.
EXCLUDED_COMMODITIES_REQUIRE_REFERRAL = {
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
}

PERIL_LOADING_FACTORS = {
    "theft": 4.09, "accidental_damage": 1.00, "load_shifting": 1.31,
    "spillage": 2.49, "hijacked": 2.19, "accident": 0.74,
    "water_damage": 0.98, "fire_explosion": 1.33,
}
GEOGRAPHIC_ZONE_LOADING = {"western_cape": 1.00, "medium_risk": 1.15, "gauteng_high_risk": 1.30}
CLAIMS_HISTORY_LOADING = {"clean": 1.00, "one_claim": 1.15}
FLEET_AGE_LOADING = {"new": 1.00, "over_10yr": 1.15}
NIGHT_OPS_LOADING = {"under_30pct": 1.00, "over_30pct": 1.20}
CROSS_BORDER_LOADING = {"local": 1.00, "sadc": 1.25}
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
NO_IOT_PENALTY = 0.20
MAX_IOT_CREDIT = -0.40
PROPOSED_CARGOSNAP_CREDIT = -0.08
PROPOSED_CVTSCPI_RMP_CREDITS = {
    "none": 0.0, "rmp1_top_lock": -0.10,
    "rmp2_cable_lock": -0.15, "rmp3_tracktag": -0.20,
}

# v2: minimum premium floor (Hollard GIT minimum: R5,000 annual per policy)
MIN_ANNUAL_PREMIUM = 5000.00
MIN_MONTHLY_PREMIUM = MIN_ANNUAL_PREMIUM / 12

# v2: regional referral thresholds on load_limit_per_vehicle (Hollard section 4.1 Referrals)
REFERRAL_LOAD_LIMIT_WESTERN_CAPE = 1500000  # Cape Town
REFERRAL_LOAD_LIMIT_OTHER_ZONES = 1000000   # JHB / KZN (gauteng_high_risk, medium_risk)

# v2: loss ratio referral threshold (Hollard section 4.3 Referrals)
LOSS_RATIO_REFERRAL_THRESHOLD_PCT = 65.0

# v2: restricted cover tiers, expressed as a fraction of the All Risks premium
RESTRICTED_COVER_FACTORS = {
    "all_risks": 1.00,
    "fire_collision_overturning_theft_hijack": 0.80,
    "fire_collision_overturning_only": 0.75,
}


@dataclass
class FleetInput:
    fleet_name: str
    vehicle_count: int
    load_limit_per_vehicle: float
    commodity_type: str
    geographic_zone: str = "western_cape"
    claims_history: str = "clean"
    loss_ratio_pct: float = None  # v2: actual loss ratio %, if known. None = not yet available.
    fleet_age: str = "new"
    night_ops: str = "under_30pct"
    cross_border: str = "local"
    iot_devices_fitted: list = field(default_factory=list)
    cargosnap_fitted: bool = False
    cvtscpi_rmp_tier: str = "none"
    is_high_value_cargo: bool = False
    is_rmp1_scoped: bool = False
    cover_type: str = "all_risks"  # v2: "all_risks" | "fire_collision_overturning_theft_hijack" | "fire_collision_overturning_only"
    manual_commodity_factor: float = None  # v2: only used when overriding an excluded-commodity referral


def compute_iot_credit_stack(f):
    if not f.iot_devices_fitted and not f.cargosnap_fitted and f.cvtscpi_rmp_tier == "none":
        return {"total_credit": NO_IOT_PENALTY, "detail": "No IoT devices fitted"}
    total = 0.0
    detail = []
    for device in f.iot_devices_fitted:
        if device in IOT_CREDITS:
            total += IOT_CREDITS[device]
            detail.append(f"{device}: {IOT_CREDITS[device]:.0%}")
    if f.cargosnap_fitted:
        total += PROPOSED_CARGOSNAP_CREDIT
        detail.append("cargosnap (proposed): -8%")
    if f.cvtscpi_rmp_tier != "none":
        credit = PROPOSED_CVTSCPI_RMP_CREDITS.get(f.cvtscpi_rmp_tier, 0.0)
        total += credit
        detail.append(f"cvtscpi_{f.cvtscpi_rmp_tier}: {credit:.0%}")
    capped = max(total, MAX_IOT_CREDIT)
    return {"total_credit": capped, "uncapped": total, "detail": detail, "capped": capped != total}


def check_mandatory_security_requirement(f):
    in_scope = f.is_high_value_cargo and f.is_rmp1_scoped
    if not in_scope:
        return {"in_scope": False, "mandatory_met": True,
                "note": "Fleet outside high-value/RMP-1 scope - no mandatory requirement applies"}
    tiers_ok = {"rmp1_top_lock", "rmp2_cable_lock", "rmp3_tracktag"}
    mandatory_met = f.cvtscpi_rmp_tier in tiers_ok
    return {
        "in_scope": True, "mandatory_met": mandatory_met,
        "note": "RMP 1 minimum satisfied" if mandatory_met else
                "COVER CANNOT BIND - CV+TS+CPI RMP 1 (Top Lock) required",
    }


def check_referral_triggers(f):
    """
    v2: Returns a list of reasons requiring referral to management, or an empty list if none.
    Checks (in order): excluded commodity, regional load-limit threshold, loss ratio.
    """
    reasons = []

    if f.commodity_type in EXCLUDED_COMMODITIES_REQUIRE_REFERRAL:
        reasons.append(
            f"Commodity '{f.commodity_type}' requires a case-by-case security assessment based on "
            f"transport form/subtype - management approval required before quoting"
        )

    if f.geographic_zone == "western_cape":
        if f.load_limit_per_vehicle > REFERRAL_LOAD_LIMIT_WESTERN_CAPE:
            reasons.append(
                f"Load limit R{f.load_limit_per_vehicle:,.0f} exceeds Cape Town referral threshold "
                f"of R{REFERRAL_LOAD_LIMIT_WESTERN_CAPE:,.0f}"
            )
    else:
        if f.load_limit_per_vehicle > REFERRAL_LOAD_LIMIT_OTHER_ZONES:
            reasons.append(
                f"Load limit R{f.load_limit_per_vehicle:,.0f} exceeds JHB/KZN referral threshold "
                f"of R{REFERRAL_LOAD_LIMIT_OTHER_ZONES:,.0f}"
            )

    if f.loss_ratio_pct is not None and f.loss_ratio_pct > LOSS_RATIO_REFERRAL_THRESHOLD_PCT:
        reasons.append(
            f"Loss ratio {f.loss_ratio_pct:.1f}% exceeds referral threshold of "
            f"{LOSS_RATIO_REFERRAL_THRESHOLD_PCT:.0f}%"
        )

    return reasons


def compute_pvpm(f, override=None):
    """
    override: optional dict {"approver_name": str, "reason": str}. If provided, bypasses the
    REFER checks (excluded commodity / regional load limit / loss ratio) and proceeds directly
    to premium calculation. Does NOT bypass the mandatory CV+TS+CPI RMP1 security requirement,
    since that reflects physical equipment fitted, not a judgment call management can waive.
    Every override is recorded in the returned result for audit purposes.
    """
    # v2: excluded-commodity / regional / loss-ratio referral check happens FIRST, before any
    # premium math, so a REFER verdict never implies a computed price - unless overridden.
    referral_reasons = check_referral_triggers(f)
    if referral_reasons and override is None:
        return {
            "fleet_name": f.fleet_name,
            "base_pvpm": None,
            "loaded_pvpm": None,
            "iot_credit": None,
            "final_pvpm": None,
            "vehicle_count": f.vehicle_count,
            "total_monthly_premium": None,
            "annual_premium": None,
            "mandatory_security": None,
            "referral_reasons": referral_reasons,
            "override_applied": False,
            "verdict": "REFER",
        }

    commodity_factor = COMMODITY_FACTORS.get(f.commodity_type)
    manual_factor_used = False
    if commodity_factor is None:
        if (
            override is not None
            and f.commodity_type in EXCLUDED_COMMODITIES_REQUIRE_REFERRAL
            and f.manual_commodity_factor is not None
        ):
            if f.manual_commodity_factor <= 0:
                return {"error": f"manual_commodity_factor must be a positive number, got {f.manual_commodity_factor}"}
            commodity_factor = f.manual_commodity_factor
            manual_factor_used = True
        elif f.commodity_type in EXCLUDED_COMMODITIES_REQUIRE_REFERRAL:
            return {
                "error": f"Commodity '{f.commodity_type}' has no standard rate - a manual_commodity_factor "
                f"must be supplied together with the management override before this can be priced"
            }
        else:
            return {"error": f"Unknown commodity_type: {f.commodity_type}"}
    base_pvpm = BASE_MONTHLY_RATE * commodity_factor * ALL_RISKS_PERIL_BLEND * f.load_limit_per_vehicle
    geo = GEOGRAPHIC_ZONE_LOADING.get(f.geographic_zone, 1.00)
    claims = CLAIMS_HISTORY_LOADING.get(f.claims_history, 1.00)
    age = FLEET_AGE_LOADING.get(f.fleet_age, 1.00)
    night = NIGHT_OPS_LOADING.get(f.night_ops, 1.00)
    cross = CROSS_BORDER_LOADING.get(f.cross_border, 1.00)
    loaded_pvpm = base_pvpm * geo * claims * age * night * cross

    # v2: restricted cover tier applied before IoT credits, matching Hollard/Merx structure
    # (restricted cover is a percentage of the All Risks premium, not stacked with IoT credits)
    restricted_factor = RESTRICTED_COVER_FACTORS.get(f.cover_type, 1.00)
    loaded_pvpm = loaded_pvpm * restricted_factor

    iot = compute_iot_credit_stack(f)
    final_pvpm = loaded_pvpm + loaded_pvpm * iot["total_credit"]
    security = check_mandatory_security_requirement(f)
    total_monthly = final_pvpm * f.vehicle_count if security["mandatory_met"] else None

    # v2: minimum annual premium floor (R5,000/policy/year, matching Hollard's GIT minimum)
    if total_monthly is not None:
        annual_before_floor = total_monthly * 12
        if annual_before_floor < MIN_ANNUAL_PREMIUM:
            annual_premium = MIN_ANNUAL_PREMIUM
            total_monthly = MIN_ANNUAL_PREMIUM / 12
            min_premium_applied = True
        else:
            annual_premium = annual_before_floor
            min_premium_applied = False
    else:
        annual_premium = None
        min_premium_applied = False

    return {
        "fleet_name": f.fleet_name,
        "base_pvpm": round(base_pvpm, 2),
        "loaded_pvpm": round(loaded_pvpm, 2),
        "iot_credit": iot,
        "final_pvpm": round(final_pvpm, 2),
        "vehicle_count": f.vehicle_count,
        "total_monthly_premium": round(total_monthly, 2) if total_monthly else None,
        "annual_premium": round(annual_premium, 2) if annual_premium else None,
        "min_premium_applied": min_premium_applied,
        "cover_type": f.cover_type,
        "mandatory_security": security,
        "override_applied": bool(override is not None and referral_reasons),
        "override_approver_name": override.get("approver_name") if override and referral_reasons else None,
        "override_reason": override.get("reason") if override and referral_reasons else None,
        "bypassed_referral_reasons": referral_reasons if override and referral_reasons else None,
        "manual_factor_used": manual_factor_used,
        "commodity_factor_applied": commodity_factor,
        "verdict": "QUOTABLE" if security["mandatory_met"] else "CANNOT BIND - mandatory security requirement not met",
    }
