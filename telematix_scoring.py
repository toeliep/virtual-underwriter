"""
TelematiX HCV Risk Rating Engine
---------------------------------
Deterministic scoring logic ported from TelematiX_Rating_Matrix_Frans_Prinsloo.xlsx
Section B weights, Section C modifiers, Section E auto-decline triggers — plus two
rules agreed with Frans Prinsloo (July 2026) that the original workbook did not encode:

  - Sustained Trend Referral: Amber-band fleet (66-85) rising 4+ consecutive months
    with no plateau is referred for review even if no hard trigger fires.
  - Post-Breach Recovery Clause: a fleet that triggered auto-decline stays off cover
    until (a) 3 consecutive clean months AND (b) documented driver retraining +
    verified speed limiter setting, AND (c) the next scheduled annual review date.

This module intentionally does NOT call an LLM anywhere. Every number here is a
literal port of Frans's formulas or an explicit rule he confirmed. Per the Virtual
Underwriter's design principle: the LLM explains and flags, it never computes a
rating number itself.
"""

from dataclasses import dataclass, field
from typing import Optional


WEIGHTS = {
    "fatigue_hos": 0.20,
    "speeding": 0.15,
    "cellphone_usage": 0.15,
    "safety_belt": 0.10,
    "driver_behaviour_composite": 0.10,
    "distance_index": 0.08,
    "device_integrity": 0.07,
    "time_on_road": 0.03,
    "night_driving_ratio": 0.02,
}

TREND_MODIFIERS = {
    "improving_strongly": -0.15,
    "improving_slightly": -0.05,
    "stable": 0.0,
    "deteriorating_slightly": 0.10,
    "deteriorating_3plus_months": 0.20,
}


@dataclass
class MonthlyBehaviouralInputs:
    fatigue_hos: Optional[float] = None
    speeding: Optional[float] = None
    cellphone_talking: Optional[float] = None
    cellphone_texting: Optional[float] = None
    safety_belt: Optional[float] = None
    driver_behaviour_composite: Optional[float] = None
    distance_index: Optional[float] = None
    device_integrity: Optional[float] = None
    time_on_road: Optional[float] = None
    night_driving_ratio: Optional[float] = None
    concealment_events: Optional[int] = None
    km_per_vehicle_month: Optional[float] = None
    combined_score_reported: Optional[float] = None


@dataclass
class FleetRecord:
    name: str
    static_risk_score: Optional[float] = None
    static_risk_complete: bool = True
    months: list = field(default_factory=list)
    prior_breach_month_index: Optional[int] = None
    intervention_documented: bool = False
    months_since_last_annual_review: int = 0


def cellphone_usage_score(m: MonthlyBehaviouralInputs) -> Optional[float]:
    if m.cellphone_talking is None or m.cellphone_texting is None:
        return None
    return (m.cellphone_talking + m.cellphone_texting) / 2


def weighted_behavioural_score(m: MonthlyBehaviouralInputs) -> dict:
    values = {
        "fatigue_hos": m.fatigue_hos,
        "speeding": m.speeding,
        "cellphone_usage": cellphone_usage_score(m),
        "safety_belt": m.safety_belt,
        "driver_behaviour_composite": m.driver_behaviour_composite,
        "distance_index": m.distance_index,
        "device_integrity": m.device_integrity,
        "time_on_road": m.time_on_road,
        "night_driving_ratio": m.night_driving_ratio,
    }
    missing = [k for k, v in values.items() if v is None]
    present_weight = sum(WEIGHTS[k] for k, v in values.items() if v is not None)
    if present_weight == 0:
        return {"score": None, "missing_fields": missing, "weight_used": 0.0}
    weighted_sum = sum(values[k] * WEIGHTS[k] for k in values if values[k] is not None)
    scaled_score = weighted_sum * (0.9 / present_weight) if present_weight else None
    return {"score": round(scaled_score, 2) if scaled_score is not None else None,
            "missing_fields": missing, "weight_used": round(present_weight, 2)}


def check_auto_decline_triggers(m: MonthlyBehaviouralInputs, combined_score: Optional[float]) -> list:
    triggers = []
    if combined_score is not None and combined_score > 100:
        triggers.append("Combined risk score > 100")
    if m.km_per_vehicle_month is not None and m.km_per_vehicle_month > 16000:
        triggers.append(f"km/vehicle/month {m.km_per_vehicle_month:.0f} exceeds 16,000 (illegal HoS for single driver)")
    if m.concealment_events is not None and m.concealment_events > 200:
        triggers.append(f"Device concealment events {m.concealment_events}/mo exceeds 200")
    if m.speeding is not None and m.fatigue_hos is not None and m.speeding > 60 and m.fatigue_hos > 80:
        triggers.append(f"Speeding ({m.speeding}) AND Fatigue ({m.fatigue_hos}) both breach simultaneously")
    return triggers


def check_rising_trend_referral(monthly_combined_scores: list, band_low=66, band_high=85) -> Optional[str]:
    if len(monthly_combined_scores) < 4:
        return None
    last4 = monthly_combined_scores[-4:]
    strictly_rising = all(last4[i] < last4[i + 1] for i in range(3))
    current = last4[-1]
    in_amber = band_low <= current <= band_high
    if strictly_rising and in_amber:
        return (f"Referred: {len(last4)}-month rising trend ({last4[0]:.0f} -> {last4[-1]:.0f}) "
                f"in Amber band, no plateau — refer for underwriting review per trend rule")
    return None


def check_recovery_status(fleet: FleetRecord, current_month_index: int) -> dict:
    if fleet.prior_breach_month_index is None:
        return {"status": "n/a", "note": "No prior breach on record"}

    clean_months = 0
    for m in fleet.months[fleet.prior_breach_month_index + 1: current_month_index + 1]:
        triggers = check_auto_decline_triggers(m, m.combined_score_reported)
        if not triggers:
            clean_months += 1
        else:
            clean_months = 0

    conditions_met = (clean_months >= 3) and fleet.intervention_documented
    at_annual_review = fleet.months_since_last_annual_review == 0

    if conditions_met and at_annual_review:
        return {"status": "REINSTATED", "clean_months": clean_months,
                "note": "3+ clean months, intervention documented, annual review reached — breach record cleared"}
    elif conditions_met and not at_annual_review:
        return {"status": "OFF COVER — AWAITING ANNUAL REVIEW", "clean_months": clean_months,
                "note": "Conditions met but reinstatement withheld until next scheduled annual review (Frans's rule)"}
    else:
        return {"status": "OFF COVER — CONDITIONS NOT MET", "clean_months": clean_months,
                "intervention_documented": fleet.intervention_documented}


def score_fleet(fleet: FleetRecord) -> dict:
    if not fleet.months:
        return {"fleet": fleet.name, "verdict": "NO DATA", "detail": "No monthly records supplied"}

    monthly_results = []
    combined_scores_for_trend = []
    breach_this_run = None

    for i, m in enumerate(fleet.months):
        beh = weighted_behavioural_score(m)
        static_adj = 0.0
        if fleet.static_risk_score is not None:
            static_adj = fleet.static_risk_score * 0.1 if not fleet.static_risk_complete else 0.0
        combined = None
        if beh["score"] is not None:
            combined = beh["score"] + static_adj

        trigger_basis = combined if combined is not None else m.combined_score_reported
        triggers = check_auto_decline_triggers(m, trigger_basis)

        if triggers and breach_this_run is None:
            breach_this_run = i

        combined_scores_for_trend.append(
            m.combined_score_reported if m.combined_score_reported is not None else combined
        )

        monthly_results.append({
            "month_index": i,
            "computed_behavioural_score": beh["score"],
            "missing_fields": beh["missing_fields"],
            "combined_score_used_for_triggers": trigger_basis,
            "auto_decline_triggers": triggers,
        })

    if fleet.prior_breach_month_index is None and breach_this_run is not None:
        fleet.prior_breach_month_index = breach_this_run

    latest = monthly_results[-1]
    verdict = {"fleet": fleet.name, "monthly_results": monthly_results}

    if latest["combined_score_used_for_triggers"] is None:
        verdict["verdict"] = "INSUFFICIENT DATA — no usable combined score extracted, cannot verify"
    elif fleet.prior_breach_month_index is not None:
        recovery = check_recovery_status(fleet, len(fleet.months) - 1)
        verdict["recovery_status"] = recovery
        verdict["verdict"] = recovery["status"]
    elif latest["auto_decline_triggers"]:
        verdict["verdict"] = "DECLINE — auto-decline trigger(s) fired"
        verdict["triggers"] = latest["auto_decline_triggers"]
    else:
        trend_ref = check_rising_trend_referral(
            [s for s in combined_scores_for_trend if s is not None]
        )
        if trend_ref:
            verdict["verdict"] = "REFER — sustained rising trend"
            verdict["trend_detail"] = trend_ref
        else:
            verdict["verdict"] = "ACCEPT — no trigger, no adverse trend"

    verdict["latest_combined_score"] = latest["combined_score_used_for_triggers"]
    return verdict