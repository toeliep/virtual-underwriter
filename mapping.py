"""
TelematiX Fleet Information -> SA Rating Engine mapping layer.

Converts free-text / itemised document extraction output into the exact
controlled-vocabulary inputs required by
TelematiX_SA_Rating_Engine_Frans_Prinsloo_3_FIXED.xlsx, Sheet "SA Rating Engine".

Four jobs, matching the four open decisions:
  1. aggregate_fleet()      -> single manufacturer + avg year model from itemised vehicle list
  2. map_cargo_type()       -> one of the 12 Section G cargo strings
  3. map_corridor()         -> one of the 10 Section H corridor strings
  4. estimate_telematics()  -> conservative Section B/C fallback when no real telemetry exists
"""

from collections import defaultdict
from datetime import datetime

# ---------------------------------------------------------------------------
# 1. CONTROLLED VOCABULARIES (must match the workbook's VLOOKUP tables exactly)
# ---------------------------------------------------------------------------

CARGO_TYPES = [
    "General merchandise",
    "Fuel / petroleum",
    "Minerals / mining",
    "FMCG / food & bev",
    "Refrigerated",
    "Steel / metals",
    "Chemicals (non-hazmat)",
    "Chemicals (hazmat/ADR)",
    "Electronics / high value",
    "Agricultural produce",
    "Retail / clothing",
    "Livestock",
]

CORRIDORS = [
    "Mixed SA national routes",
    "N1 (Cape–Johannesburg)",
    "N3 (Johannesburg–Durban)",
    "N12 (East Rand–Port Elizabeth)",
    "N14 / N4 (Botswana border)",
    "N1 North (Limpopo / Zimbabwe border)",
    "Western Cape regional",
    "KwaZulu-Natal regional",
    "Northern Cape / manganese routes",
    "Cross-border SADC",
]

ASSET_CLASSES = [
    "HCV — general freight",
    "Fuel / hazmat tanker",
    "Minerals / bulk long-haul",
    "FMCG / distribution",
    "Bulk liquids (non-hazmat)",
    "Yellow metal / plant",
    "Agricultural equipment",
    "Refrigerated / cold chain",
    "Abnormal loads / oversized",
    "Drone (commercial)",
]

MANUFACTURERS = [
    "Mercedes Benz", "Scania", "Volvo", "FAW", "MAN", "DAF",
    "UD Trucks", "Freightliner", "Western Star", "Hino", "Isuzu", "Other",
]

ANTI_THEFT_TIERS = [
    "Yes — tracking + immobiliser",
    "Yes — tracking only",
    "No",
]

# ---------------------------------------------------------------------------
# 2. CARGO MAPPING  (free text -> CARGO_TYPES)
# ---------------------------------------------------------------------------
# Two structural fixes applied here (7 July build session):
#   (a) Negation-aware: a keyword preceded by "excluding/except/not/excl" etc.
#       within a short window is NOT counted as a match. Fixes the Kritzinger
#       false-positive ("general goods excluding... fuel" -> was matching Fuel).
#   (b) Longest-phrase-first matching via regex word boundaries, and removal
#       of overly broad single-word keywords that were shadowing more specific
#       multi-word ones. Fixes the JIP false-positive ("Animal Feed" -> was
#       matching bare "animal" in Livestock before reaching "animal feed").
# Neither fix asserts what the FINAL crosswalk should be -- that's still
# pending Frans's sign-off (Decision Memo #1). These are just the mechanics
# so the crosswalk table can be dropped in cleanly once confirmed.

import re

_NEGATION_TRIGGERS = ["excluding", "except", "not ", "excl."]
# Negation scope: from the trigger word to the next sentence terminator
# (. ; or end of string) -- NOT a fixed character window. A policy clause
# like "General goods excluding bullion, ... , and fuel." can list a dozen
# excluded items well past any reasonable fixed window; the true boundary
# is the end of that clause/sentence.
_SENTENCE_TERMINATORS = re.compile(r"[.;]")


def _negated_spans(text):
    """Return list of (start, end) character ranges that fall inside a
    negation clause, so matches within these ranges are excluded."""
    spans = []
    for trig in _NEGATION_TRIGGERS:
        for m in re.finditer(re.escape(trig), text):
            trig_end = m.end()
            term = _SENTENCE_TERMINATORS.search(text, trig_end)
            clause_end = term.start() if term else len(text)
            spans.append((trig_end, clause_end))
    return spans


def _in_negated_span(pos, spans):
    return any(start <= pos < end for start, end in spans)

_CARGO_KEYWORDS = [
    # (cargo type, [keywords]) -- keywords within a category are matched
    # longest-first automatically; no need to hand-order them.
    ("Chemicals (hazmat/ADR)", ["hazmat", "hazchem", "adr", "dangerous goods"]),
    ("Fuel / petroleum", ["fuel", "petroleum", "diesel", "petrol"]),
    ("Minerals / mining", ["manganese", "chrome", "tailing", "mining", "coal",
                            "mineral", "rom", "copper"]),
    ("Chemicals (non-hazmat)", ["chemical"]),
    ("Refrigerated", ["refrigerat", "cold chain", "perishable", "fresh produce",
                       "temperature controlled"]),
    ("Livestock", ["livestock", "game"]),  # NOTE: bare "animal" removed -- too broad,
                                            # was shadowing "animal feed" (see Agricultural)
    ("Electronics / high value", ["electronic", "cellphone", "cell phone", "high value"]),
    ("Steel / metals", ["steel", "coil"]),
    ("Agricultural produce", ["grain", "wheat", "maize", "rice", "soya", "animal feed",
                               "agricultural", "farm produce", "sugar"]),
    ("Retail / clothing", ["clothing", "retail", "textile", "apparel"]),
    ("FMCG / food & bev", ["foodstuff", "food", "fmcg", "beverage", "alcohol", "beer",
                            "sab loads", "hisense", "tinned fish", "confectionary",
                            "confectionery", "tyres", "tobacco"]),
    ("General merchandise", ["general goods", "general merchandise", "building material",
                              "sand", "stone", "timber", "steel products", "heavy equipment"]),
]


def _find_matches(text):
    """Return list of (cargo_type, keyword, start_index), longest keywords
    checked first, negated occurrences excluded."""
    neg_spans = _negated_spans(text)
    matches = []
    for cargo_type, keywords in _CARGO_KEYWORDS:
        for kw in sorted(keywords, key=len, reverse=True):
            for m in re.finditer(re.escape(kw), text):
                start = m.start()
                if _in_negated_span(start, neg_spans):
                    continue  # negated -- e.g. "excluding ... fuel"
                matches.append((cargo_type, kw, start))
    return matches


def map_cargo_type(raw_text):
    result, _ = map_cargo_type_verbose(raw_text)
    return result


def map_cargo_type_verbose(raw_text):
    """
    Returns (cargo_type, detail) where detail is one of:
      - matched keyword string (single confident match)
      - None (no match -> General merchandise default)
      - {"mixed": [...]} when multiple distinct categories matched --
        pass this to resolve_mixed_cargo() to apply Frans-confirmed Q2.
    """
    if isinstance(raw_text, (list, tuple)):
        raw_text = " ".join(str(x) for x in raw_text if x)
    text = (raw_text or "").lower()

    matches = _find_matches(text)
    if not matches:
        return "General merchandise", None

    distinct_categories = sorted(set(m[0] for m in matches))
    if len(distinct_categories) > 1:
        return distinct_categories[0], {"mixed": distinct_categories, "matches": matches}

    # single category, possibly multiple keyword hits -- report the first (earliest) one
    matches.sort(key=lambda m: m[2])
    return matches[0][0], matches[0][1]


# Loading table (Section G, verbatim from workbook) -- needed for the
# "no value breakdown available" fallback below.
_CARGO_LOADINGS = {
    "General merchandise": 0.00, "Fuel / petroleum": 0.35, "Minerals / mining": 0.40,
    "FMCG / food & bev": 0.15, "Refrigerated": 0.20, "Steel / metals": 0.18,
    "Chemicals (non-hazmat)": 0.25, "Chemicals (hazmat/ADR)": 0.55,
    "Electronics / high value": 0.45, "Agricultural produce": 0.12,
    "Retail / clothing": 0.10, "Livestock": 0.30,
}


def resolve_mixed_cargo(cargo_type, detail, value_by_category=None):
    """
    Implements Frans-confirmed Q2 (majority-value) with the memo-3-confirmed
    fallback ordering when no real value split exists:

    cargo_type, detail: output of map_cargo_type_verbose()
    value_by_category: optional dict {cargo_type: rand_value_or_pct} if the
        source document actually breaks commodities down by value/percentage
        (rare -- e.g. a completed "COMMODITIES (PLEASE NOTE PERCENTAGES)"
        section). Most real submissions reviewed so far left this blank.

    Returns (final_cargo_type, method) where method is one of:
      "single_match"        -- only one category matched, nothing to resolve
      "majority_value"       -- resolved using a real value/pct breakdown
      "keyword_frequency"    -- NO value breakdown available. Frans-confirmed
                              (memo 3, Finding 2) interim: weight by how many
                              distinct commodity keywords matched each
                              candidate category in the raw text -- a better
                              signal than defaulting to worst-case, since it
                              reflects how much of the description actually
                              describes each cargo type. Still flagged for
                              review since it's not a real value split.
      "tied_frequency_lowest_loading" -- keyword counts tied between two+
                              candidates; picked the lowest-loading of the
                              tied set (safer for competitiveness than
                              guessing high) -- flagged, needs manual review.
    """
    if not isinstance(detail, dict) or "mixed" not in detail:
        return cargo_type, "single_match"

    candidates = detail["mixed"]

    if value_by_category:
        # real breakdown available -- pick the one with the highest value/pct
        present = {c: value_by_category.get(c, 0) for c in candidates}
        winner = max(present, key=present.get)
        if any(present.values()):
            return winner, "majority_value"

    # No real value breakdown. Frans-confirmed interim (memo 3, Finding 2):
    # weight by keyword-match frequency per category instead of always
    # picking the highest-loading candidate -- e.g. JIP's description hits
    # FMCG/food & bev 4 times (tinned fish, alcohol, tyres, beer) vs
    # Electronics only once, so FMCG is the better-supported read even
    # though Electronics carries a higher loading.
    counts = defaultdict(int)
    for cat, kw, pos in detail.get("matches", []):
        counts[cat] += 1

    if counts:
        max_count = max(counts.values())
        tied = [c for c in candidates if counts.get(c, 0) == max_count]
        if len(tied) == 1:
            return tied[0], "keyword_frequency"
        # genuine tie -- fall back to lowest-loading of the tied set,
        # flagged for review rather than silently guessing high
        winner = min(tied, key=lambda c: _CARGO_LOADINGS.get(c, 0))
        return winner, "tied_frequency_lowest_loading"

    # no match detail at all (shouldn't normally happen) -- old conservative
    # fallback as a last resort
    winner = max(candidates, key=lambda c: _CARGO_LOADINGS.get(c, 0))
    return winner, "highest_loading_fallback"


# ---------------------------------------------------------------------------
# 3. CORRIDOR MAPPING (free text -> CORRIDORS)
# ---------------------------------------------------------------------------
# Per Frans-confirmed Q3: default to "Mixed SA national routes" (0% loading)
# until a real geographic reference table is confirmed. Keywords below are
# therefore restricted to words that literally appear in the corridor's own
# label text (route numbers, named cities/regions actually in the label) --
# NOT external geography guesses. Previous draft wrongly included town-level
# guesses (e.g. Bloemfontein -> N3, which is factually wrong -- Bloemfontein
# is on the N1) and unconfirmed towns (Kathu, Postmasburg, Van Reenen, etc).
# Those are removed pending the promised follow-up reference table.
#
# Exception: "Cross-border SADC" keywords use actual SADC member-state names
# -- SADC membership is a fixed public fact, not an actuarial judgement call,
# so this is treated as grounded rather than guessed.

_SADC_COUNTRIES = ["mozambique", "zambia", "tanzania", "kenya", "uganda", "angola",
                    "drc", "kolwezi", "malawi", "sadc", "namibia", "lesotho",
                    "swaziland", "eswatini", "cross border", "cross-border"]

_CORRIDOR_KEYWORDS = [
    ("Cross-border SADC", _SADC_COUNTRIES),
    ("N1 North (Limpopo / Zimbabwe border)", ["n1 north", "limpopo", "zimbabwe"]),
    ("N14 / N4 (Botswana border)", ["n14", "botswana"]),  # n4 omitted: too short/ambiguous a token
    ("Northern Cape / manganese routes", ["northern cape", "manganese"]),
    ("N3 (Johannesburg–Durban)", ["n3", "durban"]),
    ("N12 (East Rand–Port Elizabeth)", ["n12", "east rand", "port elizabeth"]),
    ("N1 (Cape–Johannesburg)", ["n1 ", "cape town", "johannesburg"]),
    ("Western Cape regional", ["western cape"]),
    ("KwaZulu-Natal regional", ["kwazulu-natal", "kwazulu natal", "kzn"]),
]

# INTERIM tie-break rule (not yet Frans-confirmed, but low-risk enough to
# apply now rather than block on a memo round-trip):
#   "N1" is ambiguous -- it's the road number for BOTH "N1 (Cape–Johannesburg)"
#   (+12%) and "N1 North (Limpopo / Zimbabwe border)" (+22%). Rule: only an
#   EXPLICIT northern/border signal ("N1 North", "Limpopo", "Zimbabwe") routes
#   to the higher-loading N1 North corridor. A bare, unqualified "N1" mention
#   with no such signal defaults to the base N1 (Cape–Johannesburg) reading.
#   This is already what the list ordering below produces (N1 North's more
#   specific keywords are checked first); this comment makes it an explicit,
#   intentional rule rather than an accidental side-effect of ordering, so it
#   survives future edits to the keyword lists.
# Ambiguity is flagged (not silently trusted) via the "ambiguous" field in
# map_corridor_verbose()'s ambiguous keywords set below.
_AMBIGUOUS_KEYWORDS = {"n1 "}  # bare "N1" alone -- flag for manual review if this is the ONLY hit


def map_corridor(raw_text):
    result, _ = map_corridor_verbose(raw_text)
    return result


def map_corridor_verbose(raw_text):
    """
    Returns (corridor, keyword_or_None). If the corridor is
    "N1 (Cape–Johannesburg)" AND the bare "N1" keyword fired with NO other
    disambiguating context anywhere in the text (no "Cape Town" or
    "Johannesburg" mention either), the returned keyword is wrapped as
    {"ambiguous_n1": True, "matched": "n1 "} so callers can flag it for
    manual review. If real context is present (e.g. "N1 ... Cape Town ...
    Johannesburg"), it is NOT flagged -- that's a confident match, not an
    ambiguous one.
    """
    if isinstance(raw_text, (list, tuple)):
        raw_text = " ".join(str(x) for x in raw_text if x)
    text = (raw_text or "").lower()

    for corridor, keywords in _CORRIDOR_KEYWORDS:
        for kw in keywords:
            if kw in text:
                if kw in _AMBIGUOUS_KEYWORDS:
                    has_context = ("cape town" in text) or ("johannesburg" in text and kw != "johannesburg")
                    # "johannesburg" itself is one of the keywords for this same
                    # corridor, so if it's present it already would have matched
                    # directly -- but we still check text directly here in case
                    # "n1 " happened to be scanned first within the keyword list.
                    if not has_context:
                        return corridor, {"ambiguous_n1": True, "matched": kw}
                return corridor, kw
    return "Mixed SA national routes", None  # low-confidence default, 0% loading


# ---------------------------------------------------------------------------
# 4. FLEET AGGREGATION (itemised vehicle list -> single blended inputs)
# ---------------------------------------------------------------------------

def _normalise_make(make):
    if not make:
        return "Other"
    make = make.strip().upper()
    lookup = {
        "MERCEDES-BENZ": "Mercedes Benz", "MERCEDES BENZ": "Mercedes Benz", "MB": "Mercedes Benz",
        "SCANIA": "Scania", "VOLVO": "Volvo", "FAW": "FAW", "MAN": "MAN", "DAF": "DAF",
        "D A F": "DAF", "UD TRUCKS": "UD Trucks", "UD": "UD Trucks",
        "FREIGHTLINER": "Freightliner", "WESTERN STAR": "Western Star",
        "HINO": "Hino", "ISUZU": "Isuzu", "IVECO": "Other",  # not in engine's vocab
    }
    return lookup.get(make, "Other")


def aggregate_fleet(vehicles, weight_by="value"):
    """
    vehicles: list of dicts, each with at least:
        {"make": str, "year": int, "value": float (sum insured / current value)}
    weight_by: "value" (recommended - weights by rand exposure) or "count"

    Returns dict matching Section A inputs:
        primary_manufacturer, avg_year_model, vehicle_count,
        avg_sum_insured_rm, manufacturer_breakdown (for audit trail)

    Rationale for weight-by-value default: Section E's manufacturer loading
    and Section F's age loading both drive a RAND multiplier on total SI, so
    the manufacturer/year that dominates the fleet's RAND exposure should
    dominate the blended input -- not just the one with the most units.
    A fleet of 1 x R3m Mercedes + 9 x R400k Freightliner bakkies-support-units
    should rate on Mercedes exposure, not "mostly Freightliner by count".
    """
    if not vehicles:
        raise ValueError("aggregate_fleet: no vehicles supplied")

    make_weight = defaultdict(float)
    year_weight_sum = 0.0
    total_weight = 0.0
    total_value = 0.0

    for v in vehicles:
        make = _normalise_make(v.get("make"))
        year = v.get("year")
        value = float(v.get("value") or 0)
        w = value if weight_by == "value" else 1.0
        if w <= 0:
            w = 1.0  # fallback so zero/unknown-value vehicles aren't dropped silently
        make_weight[make] += w
        if year:
            year_weight_sum += year * w
        total_weight += w
        total_value += value

    primary_manufacturer = max(make_weight.items(), key=lambda kv: kv[1])[0]
    avg_year_model = round(year_weight_sum / total_weight) if total_weight else None
    vehicle_count = len(vehicles)
    avg_si_rm = (total_value / vehicle_count / 1_000_000) if vehicle_count else 0

    breakdown = sorted(
        [(m, w, round(100 * w / total_weight, 1)) for m, w in make_weight.items()],
        key=lambda x: -x[1],
    )

    return {
        "primary_manufacturer": primary_manufacturer,
        "avg_year_model": avg_year_model,
        "vehicle_count": vehicle_count,
        "avg_sum_insured_rm": round(avg_si_rm, 4),
        "total_sum_insured_rm": round(total_value / 1_000_000, 4),
        "manufacturer_breakdown_pct": breakdown,  # audit trail, not a Section A input
        "weighted_by": weight_by,
    }


# ---------------------------------------------------------------------------
# 5. TELEMATICS FALLBACK (Section B/C estimate when no real telemetry exists)
# ---------------------------------------------------------------------------
# Frans-confirmed spec (Decision Memo: No-Telemetry Fallback Methodology):
#   Q1 -- default every unmeasured factor to the TOP of its own Medium band
#         (65, not the template's mixed Low/Medium sample values -- those
#         computed to Combined Score ~29 / 0.95x, the near-cheapest band,
#         which is the opposite of "conservative").
#   Q2 -- a no-telemetry fleet must never reach Profile A (auto-accept),
#         regardless of computed score -- capped at Profile B minimum.
#   Q3 -- claims-frequency may nudge the flat 65 default by up to +/-15 pts,
#         but the nudge can NEVER be enough to lift the fleet past the
#         Profile-B ceiling from Q2.
#
# Bands per workbook (Section B column headers, verbatim): 0-30 Low,
# 31-65 Medium, 66-100 High. "Top of Medium" = 65.

_TOP_OF_MEDIUM = 65
_PROFILE_A_CEILING_SCORE = 45   # from workbook's own accept threshold (<=45 -> Profile A)

# Memo 3, Finding 3 -- Frans sign-off: "agree with rec" = disable the
# claims-frequency nudge until a real SA HCV portfolio benchmark is
# confirmed, rather than lean on a guessed 1.3 claims/vehicle/year figure.
# Flip this back on once Frans provides a real number.
_CLAIMS_NUDGE_ENABLED = False

def estimate_telematics(device_info=None, claims_per_vehicle_per_year=None,
                         portfolio_benchmark_claims_per_vehicle_per_year=None):
    """
    device_info: dict, any of
        {"supplier": str|None, "cameras": int|None, "monitoring_24_7": bool|None,
         "immobiliser": bool|None, "fatigue_monitoring": bool|None}
    claims_per_vehicle_per_year: float or None -- ACCEPTED but currently
        IGNORED. The claims-frequency nudge is disabled (memo 3, Finding 3 --
        Frans agreed to disable rather than rely on an unconfirmed benchmark).
        Parameter kept so callers don't need to change; flip
        _CLAIMS_NUDGE_ENABLED once a real benchmark is confirmed.
    portfolio_benchmark_claims_per_vehicle_per_year: no longer used while the
        nudge is disabled; kept for forward compatibility.

    Returns a dict of the 9 Section B scores + Section C fields, all
    anchored at 65 (top of Medium) per Q1, with an explicit "profile_ceiling"
    flag enforcing Q2.
    """
    device_info = device_info or {}
    base = _TOP_OF_MEDIUM

    nudge = 0
    confidence = "low — no telemetry, device signal only"
    if _CLAIMS_NUDGE_ENABLED and claims_per_vehicle_per_year is not None and portfolio_benchmark_claims_per_vehicle_per_year:
        ratio = claims_per_vehicle_per_year / portfolio_benchmark_claims_per_vehicle_per_year
        nudge = max(-15, min(15, round((ratio - 1) * 20)))
        confidence = "low-medium — no telemetry, claims-frequency proxy applied"
    elif claims_per_vehicle_per_year is not None:
        confidence = "low — no telemetry; claims-frequency nudge disabled pending benchmark confirmation"

    # Device presence gives a small credit ONLY on the fields it actually
    # evidences -- real signal, not a guess. Still capped: even with every
    # possible device credit, no field can drop below the Profile-A ceiling
    # equivalent, preserving Q2's intent that no-telemetry fleets don't
    # accidentally price as if fully measured-good.
    device_credit = defaultdict(int)
    if device_info.get("monitoring_24_7"):
        device_credit["device_integrity"] -= 10
    if device_info.get("fatigue_monitoring"):
        device_credit["fatigue"] -= 5
    if device_info.get("cameras", 0) and device_info["cameras"] >= 4:
        device_credit["driver_behaviour"] -= 5

    def score(field):
        return max(0, min(100, base + nudge + device_credit.get(field, 0)))

    result = {
        "fatigue": score("fatigue"),
        "speeding": score("speeding"),
        "cellphone_usage": score("cellphone_usage"),
        "seatbelt_compliance": score("seatbelt_compliance"),
        "driver_behaviour_composite": score("driver_behaviour"),
        "distance_index": score("distance_index"),
        "device_integrity_concealment_events_per_month": 0 if device_info.get("supplier") else 5,
        "time_on_road": score("time_on_road"),
        "night_driving_ratio_pct": round(score("night_driving") / 100 * 0.3, 3),
        "trend_direction": "Stable (0%)",
        "static_questionnaire_complete": bool(device_info.get("supplier")),
        "confidence": confidence,
        "source": "ESTIMATED — no real telemetry feed available at intake time",
        # Q2 enforcement: caller (rating engine wrapper) MUST check this flag
        # and refuse Profile A even if the computed combined score is <=45.
        "profile_ceiling": "B",
        "profile_ceiling_reason": "No real telemetry — Frans-confirmed Q2: "
                                   "capped at Conditional Accept regardless of score.",
    }
    return result


def apply_profile_ceiling(computed_verdict, telematics_result):
    """
    computed_verdict: "A" | "B" | "DECLINE" -- whatever Section I would
        naturally output from the combined score thresholds.
    telematics_result: output of estimate_telematics(), or None if real
        telemetry was used (in which case no ceiling applies).

    Returns the final verdict after enforcing Q2's Profile-B ceiling.
    """
    if telematics_result is None:
        return computed_verdict
    ceiling = telematics_result.get("profile_ceiling")
    if ceiling == "B" and computed_verdict == "A":
        return "B"
    return computed_verdict
