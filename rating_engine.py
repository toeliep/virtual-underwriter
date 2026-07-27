"""
Replicates TelematiX_SA_Rating_Engine_Frans_Prinsloo_3_FIXED.xlsx Sections A-I
formula-for-formula (verified against cell formulas C106, C114, C119, C120,
C123, B126) so the Fleet Information mapping layer can produce a full quote
end-to-end, not just the individual field mappings.
"""

from mapping import (
    aggregate_fleet, map_cargo_type_verbose, resolve_mixed_cargo,
    map_corridor_verbose, estimate_telematics, apply_profile_ceiling,
)

# ---------------------------------------------------------------------------
# Verbatim loading tables pulled from the workbook (Sections E, F, base rates)
# ---------------------------------------------------------------------------

MANUFACTURER_LOADING = {
    "Mercedes Benz": 0.00, "Scania": 0.14, "Volvo": -0.03, "FAW": 0.10,
    "MAN": 0.08, "DAF": 0.08, "UD Trucks": 0.05, "Freightliner": -0.10,
    "Western Star": 0.15, "Hino": 0.02, "Isuzu": 0.00, "Other": 0.10,
}

# (max_age_years_exclusive_lower_bound handled via year ranges below)
AGE_BAND_LOADING = [
    (2024, 9999, 0.05),   # <3 years (2024+)
    (2021, 2023, 0.12),   # 3-5 years
    (2018, 2020, 0.22),   # 6-8 years
    (2016, 2017, 0.28),   # 9-11 years
    (2013, 2015, 0.15),   # 12-15 years
    (0, 2012, 0.20),      # >15 years (pre-2012)
]

ASSET_CLASS_BASE_RATE = {
    "HCV — general freight": 0.030, "Fuel / hazmat tanker": 0.022,
    "Minerals / bulk long-haul": 0.028, "FMCG / distribution": 0.030,
    "Bulk liquids (non-hazmat)": 0.020, "Yellow metal / plant": 0.020,
    "Agricultural equipment": 0.016, "Refrigerated / cold chain": 0.022,
    "Abnormal loads / oversized": 0.030, "Drone (commercial)": 0.014,
}

CARGO_LOADING = {
    "General merchandise": 0.00, "Fuel / petroleum": 0.35, "Minerals / mining": 0.40,
    "FMCG / food & bev": 0.15, "Refrigerated": 0.20, "Steel / metals": 0.18,
    "Chemicals (non-hazmat)": 0.25, "Chemicals (hazmat/ADR)": 0.55,
    "Electronics / high value": 0.45, "Agricultural produce": 0.12,
    "Retail / clothing": 0.10, "Livestock": 0.30,
}

CORRIDOR_LOADING = {
    "Mixed SA national routes": 0.00, "N1 (Cape–Johannesburg)": 0.12,
    "N3 (Johannesburg–Durban)": 0.18, "N12 (East Rand–Port Elizabeth)": 0.15,
    "N14 / N4 (Botswana border)": 0.20, "N1 North (Limpopo / Zimbabwe border)": 0.22,
    "Western Cape regional": 0.08, "KwaZulu-Natal regional": 0.10,
    "Northern Cape / manganese routes": 0.35, "Cross-border SADC": 0.30,
}

ANTI_THEFT_CREDIT = {
    "Yes — tracking + immobiliser": -0.12,
    "Yes — tracking only": -0.05,   # not directly observed in workbook sample;
                                     # flagged below as an assumption pending Frans confirmation
    "No": 0.00,
}

MGMT_FEE_RATE = 0.11

# ---------------------------------------------------------------------------
# RMP-1 eligibility gate (Decision Memo: RMP-1 Mandate for Loads Over R1m --
# Frans-confirmed): eligibility gate ONLY, no rating formula change (Q1).
# Trigger field = declared/stated per-load limit from the policy/application,
# not actual cargo value carried (Q2). Strictly per-load, no aggregate
# exposure test (Q3).
# ---------------------------------------------------------------------------

RMP1_THRESHOLD_RAND = 1_000_000


def check_rmp1_requirement(declared_load_limit_rand, rmp1_in_place=False):
    """
    declared_load_limit_rand: the stated per-load / any-one-conveyance limit
        from the source document (e.g. Kritzinger's R1.8m Willowton Oil /
        R1.5m other loads; PJ Lategan's R450,000 limit any one conveyance).
        None if not captured in the documents reviewed.
    rmp1_in_place: whether RMP-1 (full physical clamp + NOC + CVI) is
        confirmed fitted for this fleet.

    Returns dict: {"required": bool|None, "satisfied": bool, "reason": str}
    required=None means we don't have the data to know either way -- this
    must NOT be silently treated as "not required".
    """
    if declared_load_limit_rand is None:
        return {
            "required": None,
            "satisfied": False,
            "reason": ("Declared per-load limit not captured in documents reviewed -- "
                       "RMP-1 requirement UNKNOWN, not cleared. Obtain the figure before binding."),
        }

    required = declared_load_limit_rand > RMP1_THRESHOLD_RAND
    if not required:
        return {
            "required": False,
            "satisfied": True,
            "reason": f"Declared load limit R{declared_load_limit_rand:,.0f} is at or below "
                      f"the R{RMP1_THRESHOLD_RAND:,.0f} RMP-1 threshold.",
        }

    if rmp1_in_place:
        return {
            "required": True,
            "satisfied": True,
            "reason": f"Declared load limit R{declared_load_limit_rand:,.0f} exceeds "
                      f"R{RMP1_THRESHOLD_RAND:,.0f} -- RMP-1 required and confirmed in place.",
        }

    return {
        "required": True,
        "satisfied": False,
        "reason": f"Declared load limit R{declared_load_limit_rand:,.0f} exceeds "
                  f"R{RMP1_THRESHOLD_RAND:,.0f} -- RMP-1 required but NOT confirmed. "
                  f"Cannot bind above this limit until RMP-1 is in place.",
    }


def _age_loading(avg_year_model):
    for lo, hi, loading in AGE_BAND_LOADING:
        if lo <= avg_year_model <= hi:
            return loading
    return AGE_BAND_LOADING[-1][2]  # fallback: oldest band


def _combined_telematics_score(behavioural_weighted, trend_direction, concealment_events):
    score = behavioural_weighted
    # trend/questionnaire modifiers -- workbook shows "Stable (0%)" as 0 modifier;
    # rising/falling trend modifiers not observed in the sample row, so only
    # the 0% Stable case is implemented with confidence.
    if concealment_events > 200:
        score += 30
    elif concealment_events > 100:
        score += 15
    return round(score)


def _rating_factor(combined_score):
    if combined_score > 100:
        return "DECLINE"
    if combined_score <= 25:
        return 0.70
    if combined_score <= 45:
        return 0.95
    if combined_score <= 65:
        return 1.40
    if combined_score <= 85:
        return 1.90
    return 2.50


def _verdict(combined_score, avg_km_per_vehicle_month, concealment_events,
             speeding_score, fatigue_score):
    if (combined_score > 100 or avg_km_per_vehicle_month > 16000
            or concealment_events > 200 or (speeding_score > 60 and fatigue_score > 80)):
        return "DECLINE", "Auto-decline triggered. Do not quote."
    if combined_score <= 45:
        return "A", "ACCEPT — Profile A. Conditions: monthly data sharing, annual questionnaire."
    if combined_score <= 85:
        return "B", ("CONDITIONAL ACCEPT — Profile B. Mandatory: HoS plan, cellphone "
                      "warranty, speed limiter verification, 30-day cancellation right.")
    return "DECLINE", f"Score {combined_score} exceeds 85. Profile C threshold. Do not quote."


def calculate_premium(*, fleet_name, asset_class, vehicles, cargo_text, corridor_text,
                       device_info=None, claims_per_vehicle_per_year=None,
                       cargo_value_breakdown=None, avg_km_per_vehicle_month=9000,
                       anti_theft_tier="Yes — tracking + immobiliser",
                       real_telematics_scores=None, aggregation_weight_by="value",
                       declared_load_limit_rand=None, rmp1_in_place=False):
    """
    End-to-end: raw document data in -> full Section A-I quote out.

    vehicles: list of {"make", "year", "value"} -- per-vehicle itemised data
    cargo_text / corridor_text: raw free text from source documents
    device_info / claims_per_vehicle_per_year: passed to estimate_telematics()
        if real_telematics_scores is None
    declared_load_limit_rand / rmp1_in_place: RMP-1 eligibility gate inputs
        (Frans-confirmed, memo: RMP-1 Mandate for Loads Over R1m). This is a
        BINDING eligibility check, separate from the rating formula -- see
        the "rmp1" and "bindable" fields in the returned dict.
    cargo_value_breakdown: optional {cargo_type: value} for true majority-value
        resolution (Q2) -- most real submissions won't have this
    real_telematics_scores: optional dict of actual measured Section B scores,
        bypasses the no-telemetry fallback entirely if supplied
    """
    warnings = []

    # --- Section A: fleet aggregation ---
    agg = aggregate_fleet(vehicles, weight_by=aggregation_weight_by)

    # --- Section D: cargo + corridor ---
    cargo_raw, cargo_detail = map_cargo_type_verbose(cargo_text)
    cargo_final, cargo_method = resolve_mixed_cargo(cargo_raw, cargo_detail, cargo_value_breakdown)
    if cargo_method == "keyword_frequency":
        warnings.append(f"Cargo: genuinely mixed commodities, no value breakdown available -- "
                         f"resolved via keyword-match frequency ({cargo_final}). Not a real "
                         f"value split; flag for review if material.")
    elif cargo_method == "tied_frequency_lowest_loading":
        warnings.append(f"Cargo: genuinely mixed commodities, keyword frequency TIED between "
                         f"candidates -- defaulted to lowest-loading of the tied set "
                         f"({cargo_final}). Flag for review.")
    elif cargo_method == "highest_loading_fallback":
        warnings.append(f"Cargo: genuinely mixed commodities, no value breakdown or keyword "
                         f"detail available -- defaulted to highest-loading candidate "
                         f"({cargo_final}). Flag for review.")

    corridor_final, corridor_detail = map_corridor_verbose(corridor_text)
    if isinstance(corridor_detail, dict) and corridor_detail.get("ambiguous_n1"):
        warnings.append("Corridor: bare 'N1' with no directional context -- defaulted to "
                         "N1 (Cape–Johannesburg). Flag for review.")
    if corridor_detail is None:
        warnings.append("Corridor: no grounded keyword matched -- defaulted to Mixed SA "
                         "national routes (0% loading).")

    # --- Section B/C: telematics ---
    telematics_result = None
    if real_telematics_scores:
        scores = real_telematics_scores
        confidence = "high — real telemetry feed"
    else:
        telematics_result = estimate_telematics(
            device_info=device_info, claims_per_vehicle_per_year=claims_per_vehicle_per_year)
        scores = telematics_result
        confidence = telematics_result["confidence"]
        warnings.append(f"Telematics: {telematics_result['source']}")

    weights = {"fatigue": .20, "speeding": .15, "cellphone_usage": .15, "seatbelt_compliance": .10,
               "driver_behaviour_composite": .10, "distance_index": .08,
               "device_integrity_concealment_events_per_month": 0,  # not part of weighted sum
               "time_on_road": .03, "night_driving_ratio_pct": .02}
    behavioural_weighted = sum(scores[k] * w for k, w in weights.items() if k in scores and w > 0)

    concealment_events = scores.get("device_integrity_concealment_events_per_month", 0)
    combined_score = _combined_telematics_score(
        behavioural_weighted,
        scores.get("trend_direction", "Stable (0%)"),
        concealment_events,
    )

    telematics_factor = _rating_factor(combined_score)

    # --- Sections E-H: SA market loadings ---
    mfr_loading = MANUFACTURER_LOADING.get(agg["primary_manufacturer"], MANUFACTURER_LOADING["Other"])
    age_loading = _age_loading(agg["avg_year_model"])
    cargo_loading = CARGO_LOADING[cargo_final]
    corridor_loading = CORRIDOR_LOADING[corridor_final]
    anti_theft = ANTI_THEFT_CREDIT.get(anti_theft_tier, 0.0)
    night_ops_loading = 0.0  # not observed as a live formula in the sample; treated as 0 pending confirmation

    total_market_loading = (mfr_loading + age_loading + cargo_loading + corridor_loading
                             + anti_theft + night_ops_loading)

    combined_rating_factor = telematics_factor * (1 + total_market_loading) if telematics_factor != "DECLINE" else None

    # --- Section I: final premium ---
    base_rate = ASSET_CLASS_BASE_RATE.get(asset_class, ASSET_CLASS_BASE_RATE["HCV — general freight"])
    total_si_rm = agg["total_sum_insured_rm"]
    market_base_premium_rm = base_rate * total_si_rm

    verdict_profile, verdict_text = _verdict(
        combined_score, avg_km_per_vehicle_month, concealment_events,
        scores.get("speeding", 0), scores.get("fatigue", 0),
    )

    if telematics_result is not None:
        verdict_profile = apply_profile_ceiling(verdict_profile, telematics_result)
        if verdict_profile == "B" and _verdict(combined_score, avg_km_per_vehicle_month,
                                                concealment_events, scores.get("speeding", 0),
                                                scores.get("fatigue", 0))[0] == "A":
            warnings.append("Verdict: raw score qualified for Profile A but was capped to "
                             "Profile B -- no real telemetry (Frans-confirmed Q2).")

    risk_adjusted_premium_rm = (market_base_premium_rm * combined_rating_factor
                                 if combined_rating_factor is not None else None)
    mgmt_fee_rm = risk_adjusted_premium_rm * MGMT_FEE_RATE if risk_adjusted_premium_rm else None

    # RMP-1 eligibility gate -- separate from the risk verdict above (Q1:
    # gate only, no formula change). A fleet can be "ACCEPT — Profile A" on
    # risk grounds and still not be bindable if RMP-1 is required and missing.
    rmp1_status = check_rmp1_requirement(declared_load_limit_rand, rmp1_in_place)
    if rmp1_status["required"] is None:
        warnings.append(f"RMP-1: {rmp1_status['reason']}")
    elif rmp1_status["required"] and not rmp1_status["satisfied"]:
        warnings.append(f"RMP-1: {rmp1_status['reason']}")

    bindable = verdict_profile != "DECLINE" and rmp1_status["satisfied"]

    return {
        "fleet_name": fleet_name,
        "aggregation": agg,
        "cargo": {"type": cargo_final, "method": cargo_method, "loading": cargo_loading},
        "corridor": {"type": corridor_final, "loading": corridor_loading},
        "telematics": {"combined_score": combined_score, "factor": telematics_factor,
                        "confidence": confidence, "behavioural_weighted": round(behavioural_weighted, 2)},
        "loadings": {"manufacturer": mfr_loading, "age": age_loading, "cargo": cargo_loading,
                     "corridor": corridor_loading, "anti_theft": anti_theft,
                     "night_ops": night_ops_loading, "total": round(total_market_loading, 4)},
        "combined_rating_factor": combined_rating_factor,
        "base_rate": base_rate,
        "total_sum_insured_rm": total_si_rm,
        "market_base_premium_rm": round(market_base_premium_rm, 6),
        "risk_adjusted_premium_rm": round(risk_adjusted_premium_rm, 6) if risk_adjusted_premium_rm else None,
        "management_fee_rm": round(mgmt_fee_rm, 6) if mgmt_fee_rm else None,
        "verdict": verdict_profile,
        "verdict_text": verdict_text,
        "rmp1": rmp1_status,
        "bindable": bindable,
        "warnings": warnings,
    }
