/**
 * ORCA TelematiX — Underwriting Rules Engine
 * ============================================
 * ORCA's own free-standing underwriting IP, operating under full delegated
 * authority from Santam (capacity partner) per the 25 Jul 2026 agreement.
 *
 * Every structural PATTERN below (dual first-amount-payable, penalty excess
 * on behavioural risk factors, tracking-device gating, cover-tier by goods
 * condition, valuation-basis-by-goods-type) is standard market practice,
 * observed consistently across the Merx and Santam wordings reviewed.
 *
 * The SPECIFIC NUMBERS ORCA runs with are its own choice, not copied from
 * either insurer. Where a number below is a first proposal rather than a
 * confirmed decision, it is flagged PROVISIONAL — these are candidates for
 * Frans/Daryl sign-off, not settled figures.
 *
 * Last updated: 25 Jul 2026
 */

// ============================================================================
// SECTION 1 — Tracking & Security Gate
// ============================================================================
// Pattern confirmed in both Merx (R250k, Cat A/C) and Santam (R200k, no
// category restriction stated). ORCA sets its own threshold and category
// requirement.

export const ORCA_TRACKING_RULES = {
  // CONFIRMED (25 Jul 2026, Toelie/Frans/Daryl sign-off): R200,000 —
  // Santam's number. Captures more vehicles into the compliance
  // requirement than Merx's R250k threshold would have.
  threshold_rand: 200000,

  // CONFIRMED (25 Jul 2026): Category A or C only (never B, since B lacks
  // active recovery). Matches Merx's stricter standard.
  approved_categories: ["A", "C"],

  // Full precedent-to-liability conditions — both insurers require these
  // five elements; this is universal market practice and not really a
  // number ORCA needs to reconsider.
  precedent_conditions: [
    "device_fitted_prior_to_incident",
    "device_operational_at_time_of_incident",
    "valid_supplier_contract_with_subscription_paid",
    "monitored_24hr_by_manned_control_room",
    "supplier_notifies_insured_immediately_on_activation",
  ],

  // ORCA's own approved vendor list — starting point is Merx's published
  // list (broadest, most current), to be reviewed independently rather than
  // assumed correct for ORCA's risk appetite.
  approved_vendors: [
    "ACM Track", "Auto Trak", "Baytrac", "C Track Fleet Management Solutions",
    "Cartrack", "Digit FMS", "Geotab", "Intellidrive Vehicle Tracking",
    "Linx Telematics", "Mix Telematics", "Netstar", "Pulsit Electronics",
    "Route Management Services I-Cab", "Selftrack Asset Tracking",
    "Smartsurv Asset Tracking", "TG Tracking", "Tracetec", "Tracker",
    "Tracontime", "We Track 247",
  ],
};

/**
 * Check whether a vehicle meets ORCA's tracking-device requirement.
 * @param {Object} vehicle - { insuredValue, deviceVendor, deviceCategory, ...precedentFlags }
 * @returns {Object} { required, met, reason }
 */
export function checkTrackingGate(vehicle = {}) {
  const { insuredValue = 0, deviceVendor, deviceCategory } = vehicle;

  if (insuredValue < ORCA_TRACKING_RULES.threshold_rand) {
    return { required: false, met: true, reason: "Below tracking threshold" };
  }

  const vendorApproved = ORCA_TRACKING_RULES.approved_vendors.some(
    (v) => deviceVendor && deviceVendor.toLowerCase().includes(v.toLowerCase().split(" ")[0])
  );
  const categoryApproved = ORCA_TRACKING_RULES.approved_categories.includes(deviceCategory);

  const precedentMet = ORCA_TRACKING_RULES.precedent_conditions.every(
    (cond) => vehicle[cond] === true
  );

  const met = vendorApproved && categoryApproved && precedentMet;

  return {
    required: true,
    met,
    reason: met
      ? "Tracking requirement satisfied"
      : !vendorApproved
      ? "Device vendor not on ORCA approved list"
      : !categoryApproved
      ? `Device category '${deviceCategory}' not approved (require A or C)`
      : "One or more precedent conditions not met — refer to underwriter",
  };
}

// ============================================================================
// SECTION 2 — Excess Structure (Motor / HCV)
// ============================================================================
// Dual first-amount-payable pattern confirmed in both Merx and Santam
// wordings, worded near-identically: "the Insured shall only be responsible
// for one of the two amounts, whichever is the greater." ORCA adopts this
// mechanic — it's sound risk practice, not insurer-specific IP — with its
// own percentages.

export const ORCA_EXCESS_STRUCTURE = {
  own_damage: {
    // CONFIRMED (25 Jul 2026): Santam's proven real-world numbers adopted
    // as ORCA's own — 10% of claim (min R7,500) OR 6.5% of vehicle value,
    // whichever greater.
    pct_of_claim: 0.10,
    min_amount_rand: 7500,
    pct_of_vehicle_value: 0.065,
    rule: "whichever_greater",
  },
  theft_hijack: {
    // CONFIRMED (25 Jul 2026): 15%, min R7,500 — Santam's number.
    pct_of_claim: 0.15,
    min_amount_rand: 7500,
  },
  motor_glass: {
    pct_of_claim: 0.20,
    min_amount_rand: 500,
  },
};

/**
 * Calculate the applicable excess for a claim using ORCA's dual-FAP structure.
 * @param {string} claimType - "own_damage" | "theft_hijack" | "motor_glass"
 * @param {number} claimAmount - Rand value of the claim
 * @param {number} vehicleValue - Insured value of the vehicle
 * @returns {Object} { excessAmount, basis }
 */
export function calculateExcess(claimType, claimAmount, vehicleValue) {
  const rules = ORCA_EXCESS_STRUCTURE[claimType];
  if (!rules) return { excessAmount: 0, basis: "No rule defined for claim type" };

  const pctOfClaimAmount = Math.max(
    claimAmount * rules.pct_of_claim,
    rules.min_amount_rand
  );

  if (rules.pct_of_vehicle_value == null) {
    return {
      excessAmount: Math.round(pctOfClaimAmount * 100) / 100,
      basis: `${(rules.pct_of_claim * 100).toFixed(0)}% of claim (min R${rules.min_amount_rand.toLocaleString()})`,
    };
  }

  const pctOfValueAmount = vehicleValue * rules.pct_of_vehicle_value;
  const excessAmount = Math.max(pctOfClaimAmount, pctOfValueAmount);

  return {
    excessAmount: Math.round(excessAmount * 100) / 100,
    basis:
      excessAmount === pctOfValueAmount
        ? `${(rules.pct_of_vehicle_value * 100).toFixed(1)}% of vehicle value (greater than claim-based excess)`
        : `${(rules.pct_of_claim * 100).toFixed(0)}% of claim, min R${rules.min_amount_rand.toLocaleString()} (greater than value-based excess)`,
  };
}

// ============================================================================
// SECTION 3 — Penalty Excess (Behavioural Risk Triggers)
// ============================================================================
// Both insurers apply an ADDITIONAL excess (not a premium loading) for the
// same behavioural risk triggers. The mechanic is identical; the percentage
// differs sharply (Santam 5%/R10k cap vs Merx 25%/R100k cap).
//
// DESIGN QUESTION RAISED: because ORCA's 10-factor engine already scores
// driver age/experience, night-ops %, and route risk into the premium
// itself, a claim-time penalty excess on top of that risks double-counting
// the same risk.
//
// DECISION (25 Jul 2026, Toelie): keep a modest penalty excess as a
// deliberate claims-time deterrent, accepting the overlap with the scoring
// engine as intentional — not an oversight. Santam's lower percentage (5%,
// R10k cap) adopted as ORCA's own number.

export const ORCA_PENALTY_EXCESS = {
  triggers: [
    "capsizing_whilst_tipping",
    "single_vehicle_accident",
    "driver_age_under_25",
    "driver_licence_under_3_years",
    "night_driving_23h00_04h00",
    "foreign_driver",
  ],
  pct_of_claim: 0.05, // CONFIRMED (25 Jul 2026)
  max_amount_rand: 10000, // CONFIRMED (25 Jul 2026)
};

/**
 * Check if a claim triggers ORCA's penalty excess and calculate the amount.
 * @param {Array<string>} activeTriggers - Which trigger conditions apply to this claim
 * @param {number} claimAmount
 * @returns {Object} { applies, amount, triggeredBy }
 */
export function calculatePenaltyExcess(activeTriggers = [], claimAmount = 0) {
  const matched = activeTriggers.filter((t) =>
    ORCA_PENALTY_EXCESS.triggers.includes(t)
  );

  if (matched.length === 0) {
    return { applies: false, amount: 0, triggeredBy: [] };
  }

  const rawAmount = claimAmount * ORCA_PENALTY_EXCESS.pct_of_claim;
  const amount = Math.min(rawAmount, ORCA_PENALTY_EXCESS.max_amount_rand);

  return {
    applies: true,
    amount: Math.round(amount * 100) / 100,
    triggeredBy: matched,
    capped: rawAmount > ORCA_PENALTY_EXCESS.max_amount_rand,
  };
}

// ============================================================================
// SECTION 4 — GIT Cover Tier & Settlement Basis
// ============================================================================
// This section is largely objective / non-competitive — it reflects how
// goods are actually exposed to loss, not an insurer's pricing philosophy.
// ORCA adopts the market-standard structure as-is.

export const ORCA_GIT_COVER_TIERS = {
  new_goods_enclosed: "all_risks",
  second_hand_or_not_enclosed: "restricted", // fire, collision, overturning, theft-following-peril, hijack
  livestock: "restricted_livestock", // death from fire/collision/overturning + humane killing + theft-following-peril
};

export function determineGitCoverTier(goods = {}) {
  const { isNew = true, isFullyEnclosedOrTarpaulin = true, isLivestock = false } = goods;

  if (isLivestock) return ORCA_GIT_COVER_TIERS.livestock;
  if (isNew && isFullyEnclosedOrTarpaulin) return ORCA_GIT_COVER_TIERS.new_goods_enclosed;
  return ORCA_GIT_COVER_TIERS.second_hand_or_not_enclosed;
}

export const ORCA_GIT_SETTLEMENT_BASIS = {
  new_goods: "supplier_price_or_replacement_value_whichever_least",
  second_hand: "depreciated_or_local_market_value_whichever_least",
  fresh_produce: "market_value_on_intended_sale_day_less_commission",
  ex_imported: "landed_cost_including_freight_duties_clearing_taxes",
  shipping_containers: "depreciated_market_value_or_secondhand_replacement_whichever_least",
  grain_corn: "safex_price_on_date_of_loss",
};

// ============================================================================
// SECTION 5 — Excluded Commodities
// ============================================================================
// ORCA's own combined list — union of what both insurers treat as absolute
// exclusions (never coverable) plus a broader "requires declaration" tier.
// This is a genuine underwriting-appetite decision, not a technical detail —
// flagged for Frans/Daryl review, not presented as final.

export const ORCA_EXCLUDED_COMMODITIES = {
  // PROVISIONAL — never coverable under any circumstance, matches both
  // insurers' absolute-exclusion lists closely (high fraud/valuation risk,
  // low insurability)
  absolute: [
    "arms", "ammunition", "bank_and_treasure_notes", "bullion", "cash",
    "deeds", "designs", "explosives", "furs", "gold_and_silver_articles",
    "jewellery", "plans", "precious_metals_or_stones", "specie", "stamps",
    "tickets", "travellers_cheques", "watches",
  ],

  // PROVISIONAL — requires declaration and specific underwriter approval
  // before cover attaches. Union of Merx's excluded list and Hollard's 13
  // excluded commodities from the load-limit-band system; needs reconciling
  // into one ORCA-owned list rather than carrying two separate lists.
  requires_declaration: [
    "antiques_and_antiquities", "artworks", "catalytic_converters",
    "cellular_and_smart_phones", "coal", "cobalt", "copper", "documents",
    "electronic_goods", "exotic_seafood", "fuel", "household_removals",
    "inverters_and_batteries", "liquor", "live_animals_and_game",
    "motor_vehicles_and_parts", "non_ferrous_metal",
    "pre_paid_phone_cards_or_vouchers", "solar_panels", "soya_beans",
    "tablet_computers", "tinned_fish", "tobacco_products_other_than_uncut",
    "tyres",
  ],
};

export function classifyExclusion(commodity = "") {
  const normalized = commodity.toLowerCase().trim().replace(/\s+/g, "_");

  if (ORCA_EXCLUDED_COMMODITIES.absolute.some((c) => normalized.includes(c))) {
    return { status: "absolute_exclusion", coverable: false };
  }
  if (ORCA_EXCLUDED_COMMODITIES.requires_declaration.some((c) => normalized.includes(c))) {
    return { status: "requires_declaration", coverable: "conditional" };
  }
  return { status: "standard", coverable: true };
}

// ============================================================================
// SECTION 6 — First Loss Basis
// ============================================================================
// GIT cover operates on first-loss basis (no average clause) — universal
// market practice, adopted as-is.

export const ORCA_GIT_FIRST_LOSS_BASIS = true; // No average clause applies to GIT
