/**
 * generateQuotePDF.js
 * In-browser PDF quote generator for ORCA TelematiX.
 * Uses jsPDF + jspdf-autotable. Called from "Download Quote" buttons
 * on HCV Rating, GIT Quoting, and Multi-Cohort tabs.
 *
 * Navy (#14213D) / Gold (#B5762A) branded throughout.
 */
import jsPDF from "jspdf";
import "jspdf-autotable";

const NAVY = [20, 33, 61];
const GOLD = [181, 118, 42];
const WHITE = [255, 255, 255];
const LIGHT_BG = [247, 245, 240];
const GREY = [92, 101, 112];
const BLACK = [51, 51, 51];

function fmt(n) {
  if (n == null) return "—";
  return "R" + Number(n).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function addHeader(doc, title, subtitle) {
  // Navy bar
  doc.setFillColor(...NAVY);
  doc.rect(0, 0, 210, 32, "F");

  // Gold accent line
  doc.setFillColor(...GOLD);
  doc.rect(0, 32, 210, 2, "F");

  // Title text
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(...WHITE);
  doc.text("ORCA TelematiX", 14, 14);

  doc.setFontSize(11);
  doc.setFont("helvetica", "normal");
  doc.text(title, 14, 22);

  if (subtitle) {
    doc.setFontSize(9);
    doc.text(subtitle, 14, 28);
  }

  // Date right-aligned
  doc.setFontSize(9);
  doc.setTextColor(...WHITE);
  const dateStr = new Date().toLocaleDateString("en-ZA", { day: "2-digit", month: "long", year: "numeric" });
  doc.text(dateStr, 196, 14, { align: "right" });

  return 42; // y position after header
}

function addFooter(doc) {
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    // Gold line
    doc.setFillColor(...GOLD);
    doc.rect(0, 285, 210, 0.5, "F");
    // Footer text
    doc.setFontSize(7.5);
    doc.setTextColor(...GREY);
    doc.text("ORCA TelematiX (Pty) Ltd — Indicative quotation, subject to underwriting confirmation and binding authority.", 14, 290);
    doc.text(`Page ${i} of ${pageCount}`, 196, 290, { align: "right" });
  }
}

function addSectionTitle(doc, y, text) {
  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...NAVY);
  doc.text(text, 14, y);
  // Gold underline
  doc.setDrawColor(...GOLD);
  doc.setLineWidth(0.5);
  doc.line(14, y + 1.5, 196, y + 1.5);
  return y + 8;
}

function addKeyValueTable(doc, y, rows) {
  doc.autoTable({
    startY: y,
    margin: { left: 14, right: 14 },
    columnStyles: {
      0: { cellWidth: 60, fontStyle: "bold", textColor: NAVY, fillColor: LIGHT_BG },
      1: { cellWidth: 122, textColor: BLACK },
    },
    body: rows,
    theme: "plain",
    styles: {
      fontSize: 9,
      cellPadding: 3,
      lineColor: [204, 204, 204],
      lineWidth: 0.25,
    },
    didParseCell: (data) => {
      if (data.column.index === 0) {
        data.cell.styles.fillColor = LIGHT_BG;
      }
    },
  });
  return doc.lastAutoTable.finalY + 6;
}

// ========== HCV QUOTE ==========
export function generateHcvQuotePDF(form, result) {
  const doc = new jsPDF();
  let y = addHeader(doc, "HCV Fleet Risk Rating — Indicative Quote", form.fleet_name || "Unnamed Fleet");

  // Fleet details
  y = addSectionTitle(doc, y, "Fleet Details");
  y = addKeyValueTable(doc, y, [
    ["Fleet Name", form.fleet_name || "—"],
    ["Asset Class", (form.asset_class || "").replace(/_/g, " ")],
    ["Number of Vehicles", String(form.vehicle_count)],
    ["Avg Sum Insured / Vehicle", fmt(form.avg_sum_insured_per_vehicle)],
    ["Total Fleet Sum Insured", fmt(result.total_fleet_sum_insured)],
    ["Manufacturer", (form.manufacturer || "").replace(/_/g, " ")],
    ["Vehicle Year Model", String(form.year_model)],
    ["Avg km / Vehicle / Month", String(form.avg_km_per_vehicle_month).replace(/\B(?=(\d{3})+(?!\d))/g, ",")],
  ]);

  // Rating result
  y = addSectionTitle(doc, y, "Rating Result");
  const verdictColor = result.verdict === "ACCEPT" ? [46, 125, 50] : result.verdict === "DECLINE" ? [204, 0, 0] : GOLD;
  y = addKeyValueTable(doc, y, [
    ["Verdict", result.verdict + (result.profile_label ? ` — ${result.profile_label}` : "")],
    ["Combined Telematics Score", String(result.combined_score)],
    ["Rating Factor (telematics)", result.rating_factor + "x"],
    ["SA Market Loading", ((result.sa_market_loading_pct || 0) > 0 ? "+" : "") + (result.sa_market_loading_pct || 0) + "%"],
    ["Combined Rating Factor", result.combined_rating_factor + "x"],
    ["Fleet Size Tier", result.fleet_size_tier_label || "—"],
  ]);

  // Premium summary
  y = addSectionTitle(doc, y, "Premium Summary");
  y = addKeyValueTable(doc, y, [
    ["Market Rate Base Premium", fmt(result.market_rate_base_premium)],
    ["Risk-Adjusted Annual Premium", fmt(result.risk_adjusted_annual_premium)],
    ["Management Fee (11%)", fmt(result.management_fee)],
    ["Total Annual Premium (incl. fee)", fmt((result.risk_adjusted_annual_premium || 0) + (result.management_fee || 0))],
    ["Monthly Premium", fmt(((result.risk_adjusted_annual_premium || 0) + (result.management_fee || 0)) / 12)],
  ]);

  // SA market loading breakdown
  if (result.sa_loading_breakdown && Object.keys(result.sa_loading_breakdown).length > 0) {
    y = addSectionTitle(doc, y, "SA Market Loading Breakdown");
    const loadingRows = Object.entries(result.sa_loading_breakdown).map(([key, val]) => [
      key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      typeof val === "number" ? (val > 0 ? "+" : "") + val + "%" : String(val),
    ]);
    y = addKeyValueTable(doc, y, loadingRows);
  }

  // Excess structure
  y = addSectionTitle(doc, y, "Excess Structure (Section 4 — Confirmed)");
  y = addKeyValueTable(doc, y, [
    ["Own Damage", "10% of claim (min R7,500) or 6.5% of vehicle value, whichever greater"],
    ["Theft / Hijack", "15% of claim (min R7,500)"],
    ["Penalty Excess", "5% of claim (max R10,000) — night driving 23h00-04h00, driver <25yrs or licensed <3yrs, capsizing while tipping"],
    ["Tracking Requirement", "Approved Cat A or C device required for vehicles ≥ R200,000"],
  ]);

  // Conditions
  if (result.conditions && result.conditions.length > 0) {
    y = addSectionTitle(doc, y, "Mandatory Conditions");
    doc.setFontSize(9);
    doc.setTextColor(...BLACK);
    result.conditions.forEach((c) => {
      doc.text("• " + c, 16, y);
      y += 5;
    });
    y += 4;
  }

  addFooter(doc);
  doc.save(`ORCA_TelematiX_HCV_Quote_${(form.fleet_name || "fleet").replace(/\s+/g, "_")}_${new Date().toISOString().slice(0, 10)}.pdf`);
}

// ========== GIT QUOTE ==========
export function generateGitQuotePDF(form, result) {
  const doc = new jsPDF();
  let y = addHeader(doc, "GIT Goods-in-Transit — Indicative Quote", form.fleet_name || "Unnamed Fleet");

  // Fleet details
  y = addSectionTitle(doc, y, "Fleet Details");
  y = addKeyValueTable(doc, y, [
    ["Fleet Name", form.fleet_name || "—"],
    ["Vehicle Count", String(form.vehicle_count)],
    ["Load Limit / Vehicle", fmt(form.load_limit_per_vehicle)],
    ["Commodity Type", (form.commodity_type || "").replace(/_/g, " ")],
    ["Geographic Zone", (form.geographic_zone || "").replace(/_/g, " ")],
    ["Claims History", (form.claims_history || "").replace(/_/g, " ")],
    ["Cover Type", (form.cover_type || "").replace(/_/g, " ")],
    ["Fleet Age", (form.fleet_age || "").replace(/_/g, " ")],
    ["Night Operations", (form.night_ops || "").replace(/_/g, " ")],
    ["Cross-Border", (form.cross_border || "").replace(/_/g, " ")],
  ]);

  // IoT devices
  const iotDevices = (form.iot_devices_fitted || []).map((d) => d.replace(/_/g, " ")).join(", ");
  if (iotDevices) {
    y = addKeyValueTable(doc, y, [["IoT Devices Fitted", iotDevices]]);
  }

  // Pricing
  y = addSectionTitle(doc, y, "Pricing Summary");
  y = addKeyValueTable(doc, y, [
    ["Base PVPM", fmt(result.base_pvpm)],
    ["Loaded PVPM", fmt(result.loaded_pvpm)],
    ["IoT Credit", result.iot_credit_pct != null ? result.iot_credit_pct + "%" : "—"],
    ["Final PVPM", fmt(result.final_pvpm)],
    ["Total Monthly Premium", fmt(result.monthly_premium)],
    ["Total Annual Premium", fmt(result.annual_premium)],
  ]);

  // IoT credit breakdown
  if (result.iot_credit_breakdown && result.iot_credit_breakdown.length > 0) {
    y = addSectionTitle(doc, y, "IoT Credit Breakdown");
    const iotRows = result.iot_credit_breakdown.map((item) => [
      item.device.replace(/_/g, " "),
      item.credit + "%",
    ]);
    y = addKeyValueTable(doc, y, iotRows);
  }

  // Security & scope
  y = addSectionTitle(doc, y, "Security & Scope");
  y = addKeyValueTable(doc, y, [
    ["High-Value Cargo", form.is_high_value_cargo ? "Yes" : "No"],
    ["RMP1-Scoped Fleet", form.is_rmp1_scoped ? "Yes" : "No"],
    ["Cargosnap Fitted", form.cargosnap_fitted ? "Yes" : "No"],
    ["Security Device", (form.cvtscpi_rmp_tier || "none").replace(/_/g, " ")],
    ["Tracking Requirement", "Approved Cat A or C device required for loads ≥ R200,000"],
  ]);

  // Excess structure
  y = addSectionTitle(doc, y, "Excess Structure (Section 4 — Confirmed)");
  y = addKeyValueTable(doc, y, [
    ["Own Damage", "10% of claim (min R7,500) or 6.5% of vehicle value, whichever greater"],
    ["Theft / Hijack", "15% of claim (min R7,500)"],
    ["Penalty Excess", "5% of claim (max R10,000) — night driving 23h00-04h00, driver <25yrs or licensed <3yrs, capsizing while tipping"],
    ["Settlement Basis", "First-loss basis, no average clause; valuation per goods type (new goods: supplier price or replacement value, whichever least)"],
  ]);

  addFooter(doc);
  doc.save(`ORCA_TelematiX_GIT_Quote_${(form.fleet_name || "fleet").replace(/\s+/g, "_")}_${new Date().toISOString().slice(0, 10)}.pdf`);
}

// ========== MULTI-COHORT QUOTE ==========
export function generateMultiCohortQuotePDF(cohorts, fleetSummary, sharedLoadings) {
  const doc = new jsPDF();
  const quotableCohorts = cohorts.filter((c) => c._status === "quotable" || c._isQuotable);
  const fleetName = sharedLoadings?.fleet_name || "Mixed Fleet";
  let y = addHeader(doc, "Multi-Cohort Fleet — Indicative Quote", fleetName);

  // Fleet-level summary
  y = addSectionTitle(doc, y, "Fleet-Level Summary");
  y = addKeyValueTable(doc, y, [
    ["Fleet Name", fleetName],
    ["Total Vehicles", String(fleetSummary.totalVehicles || 0)],
    ["Total Monthly Premium", fmt(fleetSummary.totalMonthly)],
    ["Total Annual Premium", fmt(fleetSummary.totalAnnual)],
    ["Weighted Multiplier", (fleetSummary.weightedMult || 1.0).toFixed(2) + "x"],
    ["Quotable Cohorts", String(quotableCohorts.length) + " of " + String(cohorts.length)],
  ]);

  // Shared loadings
  if (sharedLoadings) {
    y = addSectionTitle(doc, y, "Shared Loadings (from Fleet Information)");
    y = addKeyValueTable(doc, y, [
      ["Geographic Zone", (sharedLoadings.geographic_zone || "").replace(/_/g, " ")],
      ["Claims History", (sharedLoadings.claims_history || "").replace(/_/g, " ")],
      ["Fleet Age", (sharedLoadings.fleet_age || "").replace(/_/g, " ")],
      ["Night Operations", (sharedLoadings.night_ops || "").replace(/_/g, " ")],
      ["Cross-Border", (sharedLoadings.cross_border || "").replace(/_/g, " ")],
      ["Cover Type", (sharedLoadings.cover_type || "").replace(/_/g, " ")],
      ["IoT Devices", (sharedLoadings.iot_devices || []).map((d) => d.replace(/_/g, " ")).join(", ") || "—"],
    ]);
  }

  // Per-cohort detail
  quotableCohorts.forEach((cohort, idx) => {
    // Check if we need a new page (if y > 220, start a new page)
    if (y > 220) {
      doc.addPage();
      y = 20;
    }

    y = addSectionTitle(doc, y, `Cohort ${idx + 1}: ${(cohort.asset_class || "").replace(/_/g, " ")} — ${(cohort.commodity_type || "").replace(/_/g, " ")}`);
    y = addKeyValueTable(doc, y, [
      ["Vehicle Count", String(cohort.vehicle_count || 0)],
      ["Load Limit / Vehicle", fmt(cohort.load_limit_per_vehicle)],
      ["Asset Class", (cohort.asset_class || "").replace(/_/g, " ")],
      ["Commodity Type", (cohort.commodity_type || "").replace(/_/g, " ")],
      ["Base PVPM", fmt(cohort._basePvpm || cohort.basePvpm)],
      ["Loaded PVPM", fmt(cohort._loadedPvpm || cohort.loadedPvpm)],
      ["IoT Adjustment", (cohort._iotAdjustment || cohort.iotAdjustment || 0) + "%"],
      ["Final PVPM", fmt(cohort._finalPvpm || cohort.finalPvpm)],
      ["Monthly Premium", fmt(cohort._monthlyPremium || cohort.monthlyPremium)],
      ["Annual Premium", fmt(cohort._annualPremium || cohort.annualPremium)],
      ["Tracking Status", cohort._trackingStatus || cohort.trackingStatus || "—"],
    ]);
  });

  // Referred cohorts note
  const referredCohorts = cohorts.filter((c) => c._status === "referred" || !c._isQuotable);
  if (referredCohorts.length > 0) {
    if (y > 250) { doc.addPage(); y = 20; }
    y = addSectionTitle(doc, y, "Referred Cohorts (not included in premium)");
    doc.setFontSize(9);
    doc.setTextColor(...GREY);
    referredCohorts.forEach((c) => {
      doc.text(`• ${(c.asset_class || "").replace(/_/g, " ")} — ${c.vehicle_count || 0} vehicles — ${c._referReason || c.referReason || "Referred"}`, 16, y);
      y += 5;
    });
    y += 4;
  }

  // Excess structure
  if (y > 230) { doc.addPage(); y = 20; }
  y = addSectionTitle(doc, y, "Excess Structure (Section 4 — Confirmed)");
  y = addKeyValueTable(doc, y, [
    ["Own Damage", "10% of claim (min R7,500) or 6.5% of vehicle value, whichever greater"],
    ["Theft / Hijack", "15% of claim (min R7,500)"],
    ["Penalty Excess", "5% of claim (max R10,000) — night driving 23h00-04h00, driver <25yrs or licensed <3yrs, capsizing while tipping"],
    ["Tracking Requirement", "Approved Cat A or C device required for vehicles ≥ R200,000"],
    ["Settlement Basis", "First-loss basis, no average clause"],
  ]);

  addFooter(doc);
  doc.save(`ORCA_TelematiX_MultiCohort_Quote_${fleetName.replace(/\s+/g, "_")}_${new Date().toISOString().slice(0, 10)}.pdf`);
}
