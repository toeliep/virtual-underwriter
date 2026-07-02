"""
Test harness — runs the five real RMS Transporter Risk Reports collected in this
thread through the TelematiX scoring engine and checks the output against the
known/expected verdict for each (from TelematiX Fleet Benchmarks sheet + Frans's
Portfolio Tracker notes + this thread's own trigger walkthroughs).

Where a report doesn't give us a precise per-month behavioural breakdown (most
of them don't — RMS's PDF format gives graphs, not tables, for most fields), we
feed the engine RMS's own reported combined score and whatever concealment-event
/ km figures ARE given exactly, and let the engine fall back accordingly. This is
consistent with how the engine is designed to behave on incomplete real data —
which is the actual condition the production pipeline will run under until the
raw i-Cab export exists.
"""

from telematix_scoring import FleetRecord, MonthlyBehaviouralInputs, score_fleet


def month(combined=None, km=None, concealment=None):
    return MonthlyBehaviouralInputs(
        combined_score_reported=combined,
        km_per_vehicle_month=km,
        concealment_events=concealment,
    )


# ---------------------------------------------------------------------------
# 1. MYSTIC BLUE TRADING 630 — clean accept (matches TelematiX benchmark row)
# ---------------------------------------------------------------------------
mystic_blue = FleetRecord(
    name="Mystic Blue Trading 630",
    months=[
        month(combined=c, km=9465)
        for c in [47, 49, 60, 61, 54, 53, 46, 51, 51, 47, 41, 46]
    ],
)

# ---------------------------------------------------------------------------
# 2. SILVER FALLS TRADING — clean decline, 4/4 triggers (Jan-Nov 2023)
#    Device covered counts only reported May-Nov; earlier months left None.
# ---------------------------------------------------------------------------
silver_falls_concealment = [None, None, None, None, 184, 188, 204, 290, 400, 364, 14]
silver_falls = FleetRecord(
    name="Silver Falls Trading CC",
    months=[
        month(combined=c, km=22371, concealment=conceal)
        for c, conceal in zip(
            [102, 105, 113, 109, 109, 105, 107, 105, 107, 109, 109],
            silver_falls_concealment,
        )
    ],
)

# ---------------------------------------------------------------------------
# 3. RUAH TRANSPORT — clean conditional accept, static risk present (Mar-Jun 2025)
# ---------------------------------------------------------------------------
ruah_concealment = [None, None, None, None]  # per-vehicle monthly total not isolatable from report table
ruah = FleetRecord(
    name="Ruah Transport",
    static_risk_score=47,
    static_risk_complete=False,  # "8 of 9 questions completed" per report
    months=[
        month(combined=c, km=9126)
        for c in [60, 49, 57, 56]
    ],
)

# ---------------------------------------------------------------------------
# 4. VUKUKHANYA (Akira Creative Solutions) — no hard trigger, rising trend
#    Exact monthly combined not tabulated in report (graph only); using the
#    approximation flagged to Toelie: 56 -> 61 -> 67 -> 73 (last month exact,
#    per report text: "combined risk score of 73/100").
# ---------------------------------------------------------------------------
vukukhanya = FleetRecord(
    name="Akira Creative Solutions T/A Vukukhanya",
    months=[
        month(combined=c, km=11498, concealment=conceal)
        for c, conceal in zip([56, 61, 67, 73], [1, 1, 8, 4])
    ],
)

# ---------------------------------------------------------------------------
# 5. JKW TRANSPORT — historical breach (Aug-Sep 2023), sustained recovery since
# ---------------------------------------------------------------------------
jkw_combined = [49, 48, 47, 50, 105, 107, 58, 88, 42, 43, 91, 78]
jkw_concealment = [None, None, None, None, None, None, 0, 0, 0, 0, 1, 0]  # Sep23-Mar24 only in report
jkw = FleetRecord(
    name="JKW Transport",
    months=[
        month(combined=c, km=14342, concealment=conceal)
        for c, conceal in zip(jkw_combined, jkw_concealment)
    ],
    # Per this thread: recovery requires documented intervention. Not yet on
    # file for JKW as far as we know — flagged False deliberately, not assumed.
    intervention_documented=False,
    months_since_last_annual_review=0,
)


FLEETS = [mystic_blue, silver_falls, ruah, vukukhanya, jkw]

EXPECTED = {
    "Mystic Blue Trading 630": "ACCEPT",
    "Silver Falls Trading CC": "OFF COVER",  # breaches every month -> 0 clean months -> permanently off cover in practice
    "Ruah Transport": "ACCEPT",
    "Akira Creative Solutions T/A Vukukhanya": "REFER",
    "JKW Transport": "OFF COVER",  # breached Aug-Sep23, no documented intervention -> stays off cover
}


if __name__ == "__main__":
    print("=" * 78)
    print("TelematiX Scoring Engine — Validation Run Against 5 Real RMS Reports")
    print("=" * 78)
    all_pass = True
    for fleet in FLEETS:
        result = score_fleet(fleet)
        expected_prefix = EXPECTED[fleet.name]
        got = result["verdict"]
        passed = got.startswith(expected_prefix) or expected_prefix in got
        all_pass = all_pass and passed
        status = "PASS" if passed else "FAIL"
        print(f"\n[{status}] {fleet.name}")
        print(f"  Verdict:        {got}")
        print(f"  Latest score:   {result.get('latest_combined_score')}")
        if "triggers" in result:
            print(f"  Triggers fired: {result['triggers']}")
        if "trend_detail" in result:
            print(f"  Trend detail:   {result['trend_detail']}")
        if "recovery_status" in result:
            print(f"  Recovery:       {result['recovery_status']}")
    print("\n" + "=" * 78)
    print("ALL TESTS PASSED" if all_pass else "SOME TESTS FAILED — review above")
    print("=" * 78)