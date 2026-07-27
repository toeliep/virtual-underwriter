from git_scoring import FleetInput, compute_pvpm

results = []

def check(label, condition):
    status = "PASS" if condition else "FAIL"
    results.append((status, label))
    print(f"[{status}] {label}")

print("=== REGRESSION: original 4 scenarios must still pass ===")

# Scenario 1: Motorworld (default geographic_zone = western_cape, matching original benchmark)
f = FleetInput("Motorworld", 106, 1500000, "fmcg_branded_high_risk")
r = compute_pvpm(f)
print("Full output:", r)
check("Scenario 1: base_pvpm == 14646.6", abs(r["base_pvpm"] - 14646.6) < 0.01)
check("Scenario 1: verdict == QUOTABLE", r["verdict"] == "QUOTABLE")

# Scenario 2: General cargo, GPS+geofencing
f = FleetInput("GeneralCargoCo", 50, 500000, "general_cargo",
               iot_devices_fitted=["gps_realtime_tracking", "geofencing_alerting"])
r = compute_pvpm(f)
print("Full output:", r)
check("Scenario 2: verdict == QUOTABLE", r["verdict"] == "QUOTABLE")
check("Scenario 2: iot_credit -0.25", abs(r["iot_credit"]["total_credit"] - (-0.25)) < 0.001)

# Scenario 3: High-value, RMP1-scoped, no lock -> CANNOT BIND
# NOTE: load limit lowered from the original 2,000,000 to 800,000 to stay under the new v2
# referral thresholds (CT 1.5m / JHB-KZN 1m), so this isolates the RMP1 mandatory-security
# logic specifically rather than tripping the (correct, higher-priority) referral check.
f = FleetInput("HighValueNoLock", 20, 800000, "fmcg_branded_high_risk",
               is_high_value_cargo=True, is_rmp1_scoped=True, cvtscpi_rmp_tier="none")
r = compute_pvpm(f)
print("Full output:", r)
check("Scenario 3: verdict contains CANNOT BIND", "CANNOT BIND" in r["verdict"])
check("Scenario 3: total_monthly_premium is None", r["total_monthly_premium"] is None)

# Scenario 4: High-value, RMP1 fitted + Cargosnap -> QUOTABLE
f = FleetInput("HighValueCompliant", 20, 800000, "fmcg_branded_high_risk",
               is_high_value_cargo=True, is_rmp1_scoped=True, cvtscpi_rmp_tier="rmp1_top_lock",
               cargosnap_fitted=True)
r = compute_pvpm(f)
print("Full output:", r)
check("Scenario 4: verdict == QUOTABLE", r["verdict"] == "QUOTABLE")
check("Scenario 4: mandatory_met == True", r["mandatory_security"]["mandatory_met"] == True)

# Scenario 3b (NEW): confirm that a genuinely high load limit correctly triggers REFER
# even for a high-value/RMP1-scoped fleet, taking priority over the mandatory-security check
f = FleetInput("HighValueHighLoadRefer", 20, 2000000, "fmcg_branded_high_risk",
               is_high_value_cargo=True, is_rmp1_scoped=True, cvtscpi_rmp_tier="rmp1_top_lock",
               cargosnap_fitted=True)
r = compute_pvpm(f)
print("Full output:", r)
check("Scenario 3b: high load limit -> REFER takes priority over RMP1 compliance",
      r["verdict"] == "REFER")

print("\n=== NEW v2 RULE TESTS ===")

# Rule 1: Minimum premium floor - tiny fleet should be bumped to R5,000 annual
f = FleetInput("TinyFleet", 1, 50000, "general_cargo", geographic_zone="gauteng_high_risk")
r = compute_pvpm(f)
print("Full output:", r)
check("Min premium: annual_premium == 5000.0", r["annual_premium"] == 5000.0)
check("Min premium: min_premium_applied == True", r["min_premium_applied"] == True)
check("Min premium: monthly == 416.67", abs(r["total_monthly_premium"] - 416.67) < 0.01)

# Rule 1b: A fleet large enough that the floor should NOT apply
f = FleetInput("BigFleet", 50, 500000, "general_cargo", geographic_zone="gauteng_high_risk")
r = compute_pvpm(f)
check("Min premium: floor NOT applied for big fleet", r["min_premium_applied"] == False)

# Rule 2: Regional referral - Western Cape over R1.5m -> REFER
f = FleetInput("CapeTownBigLoad", 10, 1600000, "general_cargo", geographic_zone="western_cape")
r = compute_pvpm(f)
print("Full output:", r)
check("Regional referral (CT): verdict == REFER", r["verdict"] == "REFER")
check("Regional referral (CT): total_monthly_premium is None", r["total_monthly_premium"] is None)
check("Regional referral (CT): reason mentions Cape Town threshold",
      any("Cape Town" in reason for reason in r["referral_reasons"]))

# Rule 2b: Western Cape under threshold -> should NOT refer on region grounds
f = FleetInput("CapeTownOkLoad", 10, 1400000, "general_cargo", geographic_zone="western_cape")
r = compute_pvpm(f)
check("Regional referral (CT): under threshold does not refer", r["verdict"] != "REFER")

# Rule 2c: Gauteng over R1m -> REFER
f = FleetInput("JHBBigLoad", 10, 1100000, "general_cargo", geographic_zone="gauteng_high_risk")
r = compute_pvpm(f)
print("Full output:", r)
check("Regional referral (JHB): verdict == REFER", r["verdict"] == "REFER")
check("Regional referral (JHB): reason mentions JHB/KZN threshold",
      any("JHB/KZN" in reason for reason in r["referral_reasons"]))

# Rule 2d: medium_risk zone also uses JHB/KZN threshold
f = FleetInput("MediumRiskBigLoad", 10, 1100000, "general_cargo", geographic_zone="medium_risk")
r = compute_pvpm(f)
check("Regional referral (medium_risk): verdict == REFER", r["verdict"] == "REFER")

# Rule 3: Loss ratio > 65% -> REFER
f = FleetInput("HighLossRatio", 10, 500000, "general_cargo", geographic_zone="gauteng_high_risk",
               loss_ratio_pct=72.0)
r = compute_pvpm(f)
print("Full output:", r)
check("Loss ratio referral: verdict == REFER", r["verdict"] == "REFER")
check("Loss ratio referral: reason mentions loss ratio",
      any("Loss ratio" in reason for reason in r["referral_reasons"]))

# Rule 3b: Loss ratio exactly at threshold (65.0) should NOT refer (only > triggers)
f = FleetInput("AtThresholdLossRatio", 10, 500000, "general_cargo", geographic_zone="gauteng_high_risk",
               loss_ratio_pct=65.0)
r = compute_pvpm(f)
check("Loss ratio referral: exactly at 65% does not refer", r["verdict"] != "REFER")

# Rule 3c: loss_ratio_pct not provided (None) -> should not trigger referral
f = FleetInput("NoLossRatioData", 10, 500000, "general_cargo", geographic_zone="gauteng_high_risk")
r = compute_pvpm(f)
check("Loss ratio referral: None does not refer", r["verdict"] != "REFER")

# Rule 4: Restricted cover tier - 80% and 75% factors applied correctly
f_all_risks = FleetInput("RestrictedTestBase", 10, 500000, "general_cargo",
                          geographic_zone="gauteng_high_risk", cover_type="all_risks")
r_all_risks = compute_pvpm(f_all_risks)
f_80 = FleetInput("RestrictedTest80", 10, 500000, "general_cargo",
                   geographic_zone="gauteng_high_risk", cover_type="fire_collision_overturning_theft_hijack")
r_80 = compute_pvpm(f_80)
f_75 = FleetInput("RestrictedTest75", 10, 500000, "general_cargo",
                   geographic_zone="gauteng_high_risk", cover_type="fire_collision_overturning_only")
r_75 = compute_pvpm(f_75)
print("All risks final_pvpm:", r_all_risks["final_pvpm"])
print("80% tier final_pvpm:", r_80["final_pvpm"])
print("75% tier final_pvpm:", r_75["final_pvpm"])
check("Restricted cover: 80% tier is 80% of all-risks",
      abs(r_80["final_pvpm"] - r_all_risks["final_pvpm"] * 0.80) < 0.5)
check("Restricted cover: 75% tier is 75% of all-risks",
      abs(r_75["final_pvpm"] - r_all_risks["final_pvpm"] * 0.75) < 0.5)

# Rule 5: Excluded commodity -> automatic REFER, no premium calculated
f = FleetInput("CopperLoad", 10, 500000, "copper_any_form", geographic_zone="gauteng_high_risk")
r = compute_pvpm(f)
print("Full output:", r)
check("Excluded commodity: verdict == REFER", r["verdict"] == "REFER")
check("Excluded commodity: total_monthly_premium is None", r["total_monthly_premium"] is None)
check("Excluded commodity: base_pvpm is None (no premium implied)", r["base_pvpm"] is None)
check("Excluded commodity: reason mentions commodity name",
      any("copper_any_form" in reason for reason in r["referral_reasons"]))

# Rule 5b: a different excluded commodity
f = FleetInput("JewelleryLoad", 5, 200000, "gold_silver_jewellery_watches_furs", geographic_zone="gauteng_high_risk")
r = compute_pvpm(f)
check("Excluded commodity (jewellery): verdict == REFER", r["verdict"] == "REFER")

# Rule 5c: normal commodity should NOT trigger excluded-commodity referral
f = FleetInput("NormalCommodity", 10, 500000, "general_cargo", geographic_zone="gauteng_high_risk")
r = compute_pvpm(f)
check("Normal commodity: verdict != REFER (no excluded-commodity trigger)", r["verdict"] != "REFER")

print("\n=== MANAGEMENT OVERRIDE TESTS ===")

# Override: loss ratio referral bypassed, real premium computed
f = FleetInput("OverrideLossRatio", 10, 500000, "general_cargo", geographic_zone="gauteng_high_risk", loss_ratio_pct=72.0)
r_no_override = compute_pvpm(f)
check("Without override: REFER, no premium", r_no_override["verdict"] == "REFER" and r_no_override["total_monthly_premium"] is None)
r_override = compute_pvpm(f, override={"approver_name": "Frans Prinsloo", "reason": "Loss ratio acceptable given fleet context"})
print("Full output:", r_override)
check("With override: QUOTABLE with real premium", r_override["verdict"] == "QUOTABLE" and r_override["total_monthly_premium"] is not None)
check("Override metadata: applied", r_override["override_applied"] == True)
check("Override metadata: approver name", r_override["override_approver_name"] == "Frans Prinsloo")
check("Override metadata: original referral reasons preserved", "Loss ratio" in r_override["bypassed_referral_reasons"][0])

# Override does NOT bypass mandatory RMP1 security check
f2 = FleetInput("OverrideVsSecurity", 10, 500000, "general_cargo", geographic_zone="gauteng_high_risk",
                loss_ratio_pct=72.0, is_high_value_cargo=True, is_rmp1_scoped=True, cvtscpi_rmp_tier="none")
r2 = compute_pvpm(f2, override={"approver_name": "Frans", "reason": "test"})
print("Full output:", r2)
check("Override does not bypass mandatory security (still CANNOT BIND)", "CANNOT BIND" in r2["verdict"] and r2["total_monthly_premium"] is None)

# Override on a normal fleet with no referral needed -> override_applied should be False
f3 = FleetInput("NormalNoOverride", 10, 500000, "general_cargo", geographic_zone="gauteng_high_risk")
r3 = compute_pvpm(f3, override={"approver_name": "Frans", "reason": "unnecessary"})
check("Override flag false when no referral was needed", r3["override_applied"] == False)

# Excluded commodity, override provided but NO manual factor -> clear error
f4 = FleetInput("CopperNoFactor", 10, 500000, "copper_any_form", geographic_zone="gauteng_high_risk")
r4 = compute_pvpm(f4, override={"approver_name": "Frans", "reason": "test"})
print("Full output:", r4)
check("Excluded commodity override without manual factor -> clear error", "error" in r4 and "manual_commodity_factor" in r4["error"])

# Excluded commodity, override + manual factor -> prices correctly using that factor
f5 = FleetInput("CopperWithFactor", 10, 500000, "copper_any_form", geographic_zone="gauteng_high_risk",
                manual_commodity_factor=2.5)
r5 = compute_pvpm(f5, override={"approver_name": "Frans Prinsloo", "reason": "Refined copper, agreed rate with underwriter"})
print("Full output:", r5)
check("Manual factor used flag True", r5["manual_factor_used"] == True)
check("Commodity factor applied == 2.5", r5["commodity_factor_applied"] == 2.5)
check("Verdict is QUOTABLE with real premium", r5["verdict"] == "QUOTABLE" and r5["total_monthly_premium"] is not None)
expected_base = (0.00711 / 12) * 2.5 * 2.0 * 500000
check("base_pvpm matches manual factor math", abs(r5["base_pvpm"] - round(expected_base, 2)) < 0.01)

# Negative manual factor rejected
f6 = FleetInput("BadFactor", 10, 500000, "copper_any_form", geographic_zone="gauteng_high_risk", manual_commodity_factor=-1)
r6 = compute_pvpm(f6, override={"approver_name": "Frans", "reason": "test"})
check("Negative manual factor rejected", "error" in r6)

# Manual factor set but NO override -> still REFERs normally
f7 = FleetInput("FactorNoOverride", 10, 500000, "copper_any_form", geographic_zone="gauteng_high_risk", manual_commodity_factor=2.5)
r7 = compute_pvpm(f7)
check("Manual factor alone (no override) still REFERs", r7["verdict"] == "REFER")

# Manual factor set on a normal priced commodity -> ignored
f8 = FleetInput("NormalWithStrayFactor", 10, 500000, "general_cargo", geographic_zone="gauteng_high_risk", manual_commodity_factor=99)
r8 = compute_pvpm(f8, override={"approver_name": "Frans", "reason": "irrelevant"})
check("Manual factor ignored for normal priced commodity", r8["manual_factor_used"] == False and r8["commodity_factor_applied"] == 1.00)

print("\n=== SUMMARY ===")
passed = sum(1 for status, _ in results if status == "PASS")
total = len(results)
print(f"{passed}/{total} checks passed")
if passed == total:
    print("ALL TESTS PASSED")
else:
    print("SOME TESTS FAILED - review output above")
    for status, label in results:
        if status == "FAIL":
            print("  FAILED:", label)
