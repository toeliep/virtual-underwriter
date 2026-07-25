/**
 * TelematiX Fleet Mapping Engine
 * ===============================
 * Commodity classification, mixed-cargo keyword-frequency fallback,
 * corridor ruleset, and route profile extraction.
 */

// ============================================================================
// Commodity Registry (low/medium/high risk)
// ============================================================================
const COMMODITY_REGISTRY = {
  // Low-risk commodities
  "fresh produce": { risk: "low", category: "FMCG" },
  "dry goods": { risk: "low", category: "FMCG" },
  "paper products": { risk: "low", category: "FMCG" },
  "clothing": { risk: "low", category: "Retail" },
  "household goods": { risk: "low", category: "Retail" },
  "office supplies": { risk: "low", category: "Retail" },

  // Medium-risk commodities
  "general cargo": { risk: "medium", category: "General" },
  "beverages": { risk: "medium", category: "FMCG" },
  "pharmaceuticals": { risk: "medium", category: "Pharma" },
  "electronics": { risk: "medium", category: "Retail" },
  "machinery parts": { risk: "medium", category: "Industrial" },
  "building materials": { risk: "medium", category: "Industrial" },

  // High-risk commodities
  "fuel": { risk: "high", category: "Hazmat" },
  "chemicals": { risk: "high", category: "Hazmat" },
  "explosives": { risk: "high", category: "Hazmat" },
  "hazardous materials": { risk: "high", category: "Hazmat" },
  "precious metals": { risk: "high", category: "High-Value" },
  "jewellery": { risk: "high", category: "High-Value" },
  "cash": { risk: "high", category: "High-Value" },
  "electronics (high-value)": { risk: "high", category: "High-Value" },
  "perishables": { risk: "high", category: "Perishable" },
  "livestock": { risk: "high", category: "Livestock" },
};

// Keyword frequency scoring for mixed cargo
const COMMODITY_KEYWORDS = {
  low: [
    "produce",
    "fruit",
    "vegetable",
    "dry",
    "paper",
    "clothing",
    "garment",
    "household",
    "office",
    "stationery",
  ],
  medium: [
    "cargo",
    "general",
    "beverage",
    "pharma",
    "medicine",
    "electronics",
    "machine",
    "parts",
    "building",
    "material",
    "metal",
    "furniture",
  ],
  high: [
    "fuel",
    "chemical",
    "hazmat",
    "explosive",
    "precious",
    "gold",
    "jewellery",
    "cash",
    "money",
    "perishable",
    "livestock",
    "animal",
    "live",
  ],
};

// ============================================================================
// Corridor Ruleset (fixed route classification)
// ============================================================================
const CORRIDOR_RULESET = {
  "JNB–CT": {
    distance_km: 1400,
    route_type: "long-haul",
    risk_profile: "high",
    description: "Johannesburg to Cape Town",
  },
  "JNB–DBN": {
    distance_km: 600,
    route_type: "long-haul",
    risk_profile: "medium",
    description: "Johannesburg to Durban",
  },
  "Local": {
    distance_km: 100,
    route_type: "urban",
    risk_profile: "low",
    description: "Metropolitan area only",
  },
  "Regional": {
    distance_km: 400,
    route_type: "regional",
    risk_profile: "medium",
    description: "Provincial routes",
  },
  "Long-Haul": {
    distance_km: 1000,
    route_type: "long-haul",
    risk_profile: "high",
    description: "Inter-provincial routes",
  },
};

/**
 * Classify a commodity by name using exact match or keyword fallback.
 *
 * @param {string} commodityName - Commodity description
 * @returns {Object} { risk: "low"|"medium"|"high", category, confidence: "exact"|"keyword" }
 */
export function classifyCommodity(commodityName = "") {
  if (!commodityName) {
    return {
      risk: "medium",
      category: "Unknown",
      confidence: "default",
    };
  }

  const normalized = commodityName.toLowerCase().trim();

  // Exact match
  const exactMatch = Object.entries(COMMODITY_REGISTRY).find(
    ([key]) => key === normalized
  );
  if (exactMatch) {
    const [key, data] = exactMatch;
    return {
      risk: data.risk,
      category: data.category,
      confidence: "exact",
      matchedTerm: key,
    };
  }

  // Keyword frequency fallback
  const scores = { low: 0, medium: 0, high: 0 };
  Object.entries(COMMODITY_KEYWORDS).forEach(([level, keywords]) => {
    keywords.forEach((kw) => {
      if (normalized.includes(kw)) scores[level]++;
    });
  });

  if (scores.low > 0 || scores.medium > 0 || scores.high > 0) {
    const max = Math.max(scores.low, scores.medium, scores.high);
    const risk = max === scores.high ? "high" : max === scores.medium ? "medium" : "low";
    return {
      risk,
      category: "Mixed/Inferred",
      confidence: "keyword",
      keywordScores: scores,
    };
  }

  // No matches: default to medium
  return {
    risk: "medium",
    category: "Unclassified",
    confidence: "default",
  };
}

/**
 * Detect route corridor from origin/destination.
 *
 * @param {string} origin - Origin city/area
 * @param {string} destination - Destination city/area
 * @returns {Object} Corridor details or null
 */
export function detectCorridor(origin = "", destination = "") {
  if (!origin || !destination) return null;

  const orig = origin.toLowerCase().trim();
  const dest = destination.toLowerCase().trim();

  // Match fixed corridors
  const key = Object.keys(CORRIDOR_RULESET).find((corridor) => {
    const [o, d] = corridor.split("–");
    if (!o || !d) return false;
    const co = o.toLowerCase().trim();
    const cd = d.toLowerCase().trim();
    return (
      (orig.includes(co) && dest.includes(cd)) ||
      (orig.includes(cd) && dest.includes(co))
    );
  });

  if (key) {
    return {
      corridor: key,
      ...CORRIDOR_RULESET[key],
      detected: true,
    };
  }

  return null;
}

/**
 * Extract route profile (% urban, % highway, % remote) from route description.
 *
 * Keywords:
 *   urban: city, metropolitan, metro, urban, town, residential
 *   highway: highway, freeway, interstate, national road, toll
 *   remote: rural, farm, bush, gravel, dirt, regional, off-road
 *
 * @param {string} routeDescription - Route description or notes
 * @returns {Object} { urban_pct, highway_pct, remote_pct, total_keywords_found }
 */
export function extractRouteProfile(routeDescription = "") {
  if (!routeDescription) {
    return {
      urban_pct: 33.33,
      highway_pct: 33.33,
      remote_pct: 33.34,
      total_keywords_found: 0,
      confidence: "default",
    };
  }

  const normalized = routeDescription.toLowerCase();

  const urbanKeywords = [
    "city",
    "metropolitan",
    "metro",
    "urban",
    "town",
    "residential",
    "suburb",
  ];
  const highwayKeywords = [
    "highway",
    "freeway",
    "interstate",
    "national road",
    "n1",
    "n2",
    "n3",
    "toll",
    "motorway",
  ];
  const remoteKeywords = [
    "rural",
    "farm",
    "bush",
    "gravel",
    "dirt",
    "regional",
    "off-road",
    "remote",
  ];

  let urbanCount = 0;
  let highwayCount = 0;
  let remoteCount = 0;

  urbanKeywords.forEach((kw) => {
    const regex = new RegExp(`\\b${kw}\\b`, "gi");
    const matches = normalized.match(regex);
    if (matches) urbanCount += matches.length;
  });

  highwayKeywords.forEach((kw) => {
    const regex = new RegExp(`\\b${kw}\\b`, "gi");
    const matches = normalized.match(regex);
    if (matches) highwayCount += matches.length;
  });

  remoteKeywords.forEach((kw) => {
    const regex = new RegExp(`\\b${kw}\\b`, "gi");
    const matches = normalized.match(regex);
    if (matches) remoteCount += matches.length;
  });

  const total = urbanCount + highwayCount + remoteCount;

  if (total === 0) {
    return {
      urban_pct: 33.33,
      highway_pct: 33.33,
      remote_pct: 33.34,
      total_keywords_found: 0,
      confidence: "default",
    };
  }

  const urban_pct = Math.round((urbanCount / total) * 10000) / 100;
  const highway_pct = Math.round((highwayCount / total) * 10000) / 100;
  const remote_pct = Math.round((remoteCount / total) * 10000) / 100;

  return {
    urban_pct,
    highway_pct,
    remote_pct,
    total_keywords_found: total,
    confidence: total >= 3 ? "high" : "medium",
    keywordCounts: { urban: urbanCount, highway: highwayCount, remote: remoteCount },
  };
}

/**
 * Detect asset class (vehicle type) from description.
 *
 * @param {string} vehicleDescription - Vehicle type or asset class name
 * @returns {string} Normalized asset class (LCV, Medium, Heavy, Reefer, etc.)
 */
export function detectAssetClass(vehicleDescription = "") {
  if (!vehicleDescription) return "Medium";

  const normalized = vehicleDescription.toLowerCase().trim();

  // Direct matches
  if (
    normalized.includes("lcv") ||
    normalized.includes("light") ||
    normalized.includes("sedan") ||
    normalized.includes("bakkie")
  ) {
    return "LCV";
  }

  if (
    normalized.includes("reefer") ||
    normalized.includes("refrigerated") ||
    normalized.includes("chiller")
  ) {
    return "Reefer";
  }

  if (normalized.includes("tanker")) {
    return "Tanker";
  }

  if (normalized.includes("flatbed") || normalized.includes("flat bed")) {
    return "Flatbed";
  }

  if (normalized.includes("livestock")) {
    return "Livestock";
  }

  if (normalized.includes("bulk")) {
    return "Bulk";
  }

  if (
    normalized.includes("heavy") ||
    normalized.includes("hcv") ||
    normalized.includes("truck") ||
    normalized.includes("articulated")
  ) {
    return "Heavy";
  }

  if (normalized.includes("medium") || normalized.includes("van")) {
    return "Medium";
  }

  // Default
  return "Medium";
}

/**
 * Determine mixed-cargo risk profile from list of commodities.
 *
 * @param {Array<string>} commodities - Array of commodity descriptions
 * @returns {Object} { risk: "low"|"medium"|"high", breakdown, recommendations }
 */
export function analyzeMixedCargo(commodities = []) {
  if (!commodities || commodities.length === 0) {
    return {
      risk: "medium",
      breakdown: [],
      summary: "No commodities specified — treating as general cargo",
    };
  }

  const classifications = commodities.map((c) => classifyCommodity(c));

  const breakdown = classifications.map((c, i) => ({
    commodity: commodities[i],
    ...c,
  }));

  // Aggregate risk: if any high-risk commodity, risk is high
  let overallRisk = "low";
  if (classifications.some((c) => c.risk === "high")) {
    overallRisk = "high";
  } else if (classifications.some((c) => c.risk === "medium")) {
    overallRisk = "medium";
  }

  const highRiskCount = classifications.filter((c) => c.risk === "high").length;
  const mediumRiskCount = classifications.filter((c) => c.risk === "medium").length;
  const lowRiskCount = classifications.filter((c) => c.risk === "low").length;

  let summary = `Mixed cargo: ${highRiskCount} high-risk, ${mediumRiskCount} medium-risk, ${lowRiskCount} low-risk commodities`;
  if (highRiskCount > 0) {
    summary += " — high-risk goods detected, elevated premium likely";
  }

  return {
    risk: overallRisk,
    breakdown,
    summary,
    counts: { high: highRiskCount, medium: mediumRiskCount, low: lowRiskCount },
  };
}

/**
 * Build risk profile from questionnaire inputs.
 *
 * @param {Object} questionnaire - Fleet questionnaire data
 * @returns {Object} Consolidated risk profile
 */
export function buildRiskProfile(questionnaire = {}) {
  const {
    asset_classes = [],
    commodities = [],
    routes = [],
    origin = "",
    destination = "",
  } = questionnaire;

  const assetClassProfile = asset_classes.map((a) => ({
    assetClass: detectAssetClass(a),
    original: a,
  }));

  const cargoAnalysis = analyzeMixedCargo(commodities);

  const routeProfile = routes.length > 0
    ? extractRouteProfile(routes.join(" "))
    : extractRouteProfile("");

  const corridor = detectCorridor(origin, destination);

  return {
    assetClassProfile,
    cargoAnalysis,
    routeProfile,
    corridor,
    commodities,
    summary: {
      assetClasses: [...new Set(assetClassProfile.map((a) => a.assetClass))],
      cargoRisk: cargoAnalysis.risk,
      corridorDetected: !!corridor,
    },
  };
}
