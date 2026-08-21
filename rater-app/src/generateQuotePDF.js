/**
 * generateQuotePDF.js
 * In-browser PDF quote generator for ORCA TelematiX.
 * Uses jsPDF + jspdf-autotable. Called from "Download Quote" buttons
 * on HCV Rating, GIT Quoting, and Multi-Cohort tabs.
 *
 * Navy (#14213D) / Gold (#B5762A) branded throughout.
 */
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

const NAVY = [20, 33, 61];
const GOLD = [181, 118, 42];
const WHITE = [255, 255, 255];
const LIGHT_BG = [247, 245, 240];
const GREY = [92, 101, 112];
const BLACK = [51, 51, 51];

const HCV_ASSET_CLASSES = new Set([
  "hcv_general_freight","fuel_hazmat_tanker","minerals_bulk_long_haul",
  "fmcg_distribution","bulk_liquids_non_hazmat","refrigerated_cold_chain",
  "abnormal_loads_oversized",
]);
const PLANT_AGRI_CLASSES = new Set(["yellow_metal_plant","agricultural_equipment"]);

function fmt(n) {
  if (n == null) return "—";
  return "R" + Number(n).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function addHeader(doc, title, subtitle) {
  doc.setFillColor(...NAVY);
  doc.rect(0, 0, 210, 32, "F");
  doc.setFillColor(...GOLD);
  doc.rect(0, 32, 210, 2, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(...WHITE);
  doc.text("ORCA TelematiX", 14, 14);
  doc.setFontSize(11);
  doc.setFont("helvetica", "normal");
  doc.text(title, 14, 22);
  if (subtitle) { doc.setFontSize(9); doc.text(subtitle, 14, 28); }
  doc.setFontSize(9);
  doc.setTextColor(...WHITE);
  const dateStr = new Date().toLocaleDateString("en-ZA", { day: "2-digit", month: "long", year: "numeric" });
  doc.text(dateStr, 196, 14, { align: "right" });
  return 42;
}

function addFooter(doc) {
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFillColor(...GOLD);
    doc.rect(0, 285, 210, 0.5, "F");
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
  doc.setDrawColor(...GOLD);
  doc.setLineWidth(0.5);
  doc.line(14, y + 1.5, 196, y + 1.5);
  return y + 8;
}

function addKeyValueTable(doc, y, rows) {
  autoTable(doc, {
    startY: y,
    margin: { left: 14, right: 14 },
    columnStyles: {
      0: { cellWidth: 60, fontStyle: "bold", textColor: NAVY, fillColor: LIGHT_BG },
      1: { cellWidth: 122, textColor: BLACK },
    },
    body: rows,
    theme: "plain",
    styles: { fontSize: 9, cellPadding: 3, lineColor: [204, 204, 204], lineWidth: 0.25 },
    didParseCell: (data) => {
      if (data.column.index === 0) data.cell.styles.fillColor = LIGHT_BG;
    },
  });
  return doc.lastAutoTable.finalY + 6;
}

// ========== HCV QUOTE ==========
export function generateHcvQuotePDF(form, result) {
  const doc = new jsPDF();
  let y = addHeader(doc, "HCV Fleet Risk Rating — Indicative Quote", form.fleet_name || "Unnamed Fleet");
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
  y = addSectionTitle(doc, y, "Rating Result");
  y = addKeyValueTable(doc, y, [
    ["Verdict", result.verdict || "—"],
    ["Combined Telematics Score", result.combined_telematics_score != null ? result.combined_telematics_score.toFixed(1) : "—"],
    ["Rating Factor (telematics)", result.rating_factor != null ? result.rating_factor.toFixed(2) + "x" : "—"],
    ["SA Market Loading", result.total_sa_market_loading != null ? (result.total_sa_market_loading >= 0 ? "+" : "") + (result.total_sa_market_loading * 100).toFixed(0) + "%" : "—"],
    ["Combined Rating Factor", result.combined_rating_factor != null ? result.combined_rating_factor.toFixed(2) + "x" : "—"],
    ["Fleet Size Multiplier", result.fleet_size_multiplier != null ? result.fleet_size_multiplier.toFixed(2) + "x" : "—"],
  ]);
  y = addSectionTitle(doc, y, "Premium Summary");
  const totalAnnual = (result.risk_adjusted_premium || 0) + (result.management_fee || 0);
  y = addKeyValueTable(doc, y, [
    ["Market Rate Base Premium", fmt(result.market_rate_base_premium)],
    ["Risk-Adjusted Annual Premium", fmt(result.risk_adjusted_premium)],
    ["Management Fee (11%)", fmt(result.management_fee)],
    ["Total Annual Premium (incl. fee)", fmt(totalAnnual)],
    ["Monthly Premium", fmt(totalAnnual / 12)],
  ]);
  y = addSectionTitle(doc, y, "Excess Structure (Section 4 — Confirmed)");
  y = addKeyValueTable(doc, y, [
    ["Own Damage", "10% of claim (min R7,500) or 6.5% of vehicle value, whichever greater"],
    ["Theft / Hijack", "15% of claim (min R7,500)"],
    ["Penalty Excess", "5% of claim (max R10,000) — night driving 23h00-04h00, driver <25yrs or licensed <3yrs, capsizing while tipping"],
    ["Tracking Requirement", "Approved Cat A or C device required for vehicles >= R200,000"],
  ]);
  addFooter(doc);
  doc.save(`ORCA_TelematiX_HCV_Quote_${(form.fleet_name || "fleet").replace(/\s+/g, "_")}_${new Date().toISOString().slice(0, 10)}.pdf`);
}

// ========== GIT QUOTE ==========
export function generateGitQuotePDF(form, result) {
  const doc = new jsPDF();
  let y = addHeader(doc, "GIT Goods-in-Transit — Indicative Quote", form.fleet_name || "Unnamed Fleet");
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
  const iotDevices = (form.iot_devices_fitted || []).map((d) => d.replace(/_/g, " ")).join(", ");
  if (iotDevices) y = addKeyValueTable(doc, y, [["IoT Devices Fitted", iotDevices]]);
  y = addSectionTitle(doc, y, "Pricing Summary");
  y = addKeyValueTable(doc, y, [
    ["Base PVPM", fmt(result.base_pvpm)],
    ["Loaded PVPM", fmt(result.loaded_pvpm)],
    ["IoT Credit", result.iot_credit && result.iot_credit.total_credit != null ? (result.iot_credit.total_credit * 100).toFixed(0) + "%" : "—"],
    ["Final PVPM", fmt(result.final_pvpm)],
    ["Total Monthly Premium", fmt(result.total_monthly_premium)],
    ["Total Annual Premium", fmt(result.annual_premium)],
  ]);
  y = addSectionTitle(doc, y, "Excess Structure (Section 4 — Confirmed)");
  y = addKeyValueTable(doc, y, [
    ["Own Damage", "10% of claim (min R7,500) or 6.5% of vehicle value, whichever greater"],
    ["Theft / Hijack", "15% of claim (min R7,500)"],
    ["Penalty Excess", "5% of claim (max R10,000) — night driving 23h00-04h00, driver <25yrs or licensed <3yrs, capsizing while tipping"],
    ["Settlement Basis", "First-loss basis, no average clause"],
  ]);
  addFooter(doc);
  doc.save(`ORCA_TelematiX_GIT_Quote_${(form.fleet_name || "fleet").replace(/\s+/g, "_")}_${new Date().toISOString().slice(0, 10)}.pdf`);
}

// ========== MULTI-COHORT QUOTE ==========
export function generateMultiCohortQuotePDF(cohorts, fleetSummary, sharedLoadings) {
  const doc = new jsPDF();
  const quotableCohorts = cohorts.filter((c) => c.status === "QUOTABLE");
  const fleetName = sharedLoadings?.fleet_name || "Mixed Fleet";
  let y = addHeader(doc, "Multi-Cohort Fleet — Indicative Quote", fleetName);

  y = addSectionTitle(doc, y, "Fleet-Level Summary");
  y = addKeyValueTable(doc, y, [
    ["Fleet Name", fleetName],
    ["Total Vehicles (quotable cohorts)", String(fleetSummary.totalVehicles || 0)],
    ["Total Monthly Premium", fmt(fleetSummary.totalMonthly)],
    ["Total Annual Premium", fmt(fleetSummary.totalAnnual)],
    ["Weighted Multiplier", (fleetSummary.weightedMultiplier || 1.0).toFixed(2) + "x"],
    ["Quotable Cohorts", String(quotableCohorts.length) + " of " + String(cohorts.length)],
  ]);

  if (sharedLoadings) {
    // Claims history — derive from actual HCV cohort loss ratio data, not the form field
    const hcvCohort = cohorts.find(c => HCV_ASSET_CLASSES.has(c.asset_class));
    let claimsDisplay = (sharedLoadings.claims_history || "—").replace(/_/g, " ");
    if (hcvCohort?.hcv_loss_ratio_pct != null) {
      const lr = hcvCohort.hcv_loss_ratio_pct.toFixed(1);
      if (hcvCohort.hcv_loss_ratio_override_approver) {
        claimsDisplay = `Referred — ${lr}% LR (override: ${hcvCohort.hcv_loss_ratio_override_approver})`;
      } else if (hcvCohort.hcv_loss_ratio_pct > 65) {
        claimsDisplay = `Referred — ${lr}% LR`;
      } else {
        claimsDisplay = `${lr}% LR — within threshold`;
      }
    }

    // Fleet age — compute from vehicle register average year model
    let fleetAgeDisplay = (sharedLoadings.fleet_age || "—").replace(/_/g, " ");
    const avgYear = sharedLoadings.year_model;
    if (avgYear && avgYear > 1990) {
      const age = new Date().getFullYear() - avgYear;
      if (age <= 3) fleetAgeDisplay = `New (avg ${avgYear}, ≤3 years)`;
      else if (age <= 5) fleetAgeDisplay = `3–5 years (avg ${avgYear})`;
      else if (age <= 8) fleetAgeDisplay = `6–8 years (avg ${avgYear})`;
      else if (age <= 11) fleetAgeDisplay = `9–11 years (avg ${avgYear})`;
      else fleetAgeDisplay = `Over 11 years (avg ${avgYear})`;
    }

    y = addSectionTitle(doc, y, "Shared Loadings (from Fleet Information)");
    y = addKeyValueTable(doc, y, [
      ["Geographic Zone", (sharedLoadings.geographic_zone || "").replace(/_/g, " ").replace(/\b\w/g, function(c){return c.toUpperCase()})],
      ["Claims History", claimsDisplay],
      ["Fleet Age", fleetAgeDisplay],
      ["Night Operations", sharedLoadings.night_ops_pct > 0.30 ? "over 30pct" : "under 30pct"],
      ["Cross-Border", (sharedLoadings.cross_border || "—").replace(/_/g, " ")],
      ["Cover Type", (sharedLoadings.cover_type || "—").replace(/_/g, " ")],
      ["IoT Devices", (sharedLoadings.iot_devices_fitted || sharedLoadings.iot_devices || []).map((d) => d.replace(/_/g, " ")).join(", ") || "—"],
    ]);
  }

  quotableCohorts.forEach((cohort, idx) => {
    if (y > 220) { doc.addPage(); y = 20; }

    const isHcv = HCV_ASSET_CLASSES.has(cohort.asset_class);
    const isPlantAgri = PLANT_AGRI_CLASSES.has(cohort.asset_class);
    const isTrailer = cohort.asset_class === "trailer";
    const cohortLabel = `Cohort ${idx + 1}: ${(cohort.asset_class || "").replace(/_/g, " ")} — ${(cohort.commodity_type || "").replace(/_/g, " ")}`;
    y = addSectionTitle(doc, y, cohortLabel);

    if (isHcv) {
      // HCV summary
      const qualFactor = cohort.hcv_qualifier?.factor;
      y = addKeyValueTable(doc, y, [
        ["Base Rate", "4.5% p.a. of sum insured"],
        ["Data-Source Qualifier", cohort.hcv_qualifier?.label || "—"],
        ["Qualifier Factor", qualFactor != null ? qualFactor.toFixed(2) + "×" : "—"],
        ["Loss Ratio", cohort.hcv_loss_ratio_pct != null ? cohort.hcv_loss_ratio_pct.toFixed(1) + "%" : "—"],
        ["Loss Ratio Override", cohort.hcv_loss_ratio_override_approver ? `Approved by ${cohort.hcv_loss_ratio_override_approver}` : "—"],
        ["Total Fleet Sum Insured", fmt(cohort.total_sum_insured)],
        ["Monthly Premium", fmt(cohort.cohort_monthly)],
        ["Annual Premium", fmt(cohort.cohort_annual)],
      ]);
      // Per-vehicle schedule table
      if (cohort.pricing_mode === "per_vehicle" && cohort.priced_vehicles?.length > 0) {
        if (y > 200) { doc.addPage(); y = 20; }
        doc.setFontSize(10);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(...NAVY);
        doc.text("Vehicle Schedule — Individual Premium Allocation", 14, y);
        y += 6;
        autoTable(doc, {
          startY: y,
          margin: { left: 14, right: 14 },
          head: [["Reg","Make","Model","Year","Sum Insured","Mfr Load","Age Band","Monthly","Annual"]],
          body: cohort.priced_vehicles.map(v => [
            v.registration || "—",
            v.make || "—",
            (v.model || "—").substring(0, 22),
            v.year ? String(v.year) : "—",
            `R${(v.insured_value || 0).toLocaleString("en-ZA")}`,
            v.mfr_loading != null ? (v.mfr_loading >= 0 ? "+" : "") + (v.mfr_loading * 100).toFixed(0) + "%" : "—",
            v.age_band ? v.age_band.replace(/_/g, " ") : "—",
            fmt(v.monthly),
            fmt(v.annual),
          ]),
          foot: [[
            { content: `TOTAL — ${cohort.priced_vehicles.length} vehicles`, colSpan: 4, styles: { fontStyle: "bold" } },
            { content: `R${(cohort.total_sum_insured || 0).toLocaleString("en-ZA")}`, styles: { fontStyle: "bold" } },
            "", "",
            { content: fmt(cohort.cohort_monthly) + "/mo", styles: { fontStyle: "bold" } },
            { content: fmt(cohort.cohort_annual), styles: { fontStyle: "bold" } },
          ]],
          headStyles: { fillColor: NAVY, textColor: WHITE, fontSize: 7.5 },
          footStyles: { fillColor: [232, 237, 245], textColor: NAVY, fontSize: 7.5 },
          bodyStyles: { fontSize: 7.5 },
          alternateRowStyles: { fillColor: [245, 247, 250] },
          theme: "grid",
        });
        y = doc.lastAutoTable.finalY + 8;
      }
    } else if (isPlantAgri) {
      // Plant/Agri breakdown
      y = addKeyValueTable(doc, y, [
        ["Unit Count", String(cohort.vehicle_count || 0)],
        ["Asset Class", (cohort.asset_class || "").replace(/_/g, " ")],
        ["Machine Type", (cohort.agri_machine_type || "—").replace(/_/g, " ")],
        ["Declared Value per Machine", fmt(cohort.machine_value_per_unit)],
        ["Base Rate", cohort.asset_class === "yellow_metal_plant" ? "2.0% p.a." : "1.6% p.a."],
        ["Rating Factor", cohort.rating_factor != null ? cohort.rating_factor.toFixed(2) + "×" : "—"],
        ["Profile", cohort.profile || "—"],
        ["Monthly Premium", fmt(cohort.cohort_monthly)],
        ["Annual Premium", fmt(cohort.cohort_annual)],
      ]);
    } else if (isTrailer) {
      // Trailer summary
      y = addKeyValueTable(doc, y, [
        ["Base Rate", "2.0% p.a. of sum insured"],
        ["Own Damage Excess", "10% of claim (min R15,000)"],
        ["Theft / Hijack Excess", "15% of claim (min R7,500)"],
        ["Total Sum Insured", fmt(cohort.trailer_total_si)],
        ["Monthly Premium", fmt(cohort.cohort_monthly)],
        ["Annual Premium", fmt(cohort.cohort_annual)],
      ]);
      // Per-trailer schedule table
      if (cohort.pricing_mode === "per_vehicle" && cohort.priced_trailers?.length > 0) {
        if (y > 200) { doc.addPage(); y = 20; }
        doc.setFontSize(10);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(...NAVY);
        doc.text("Trailer Schedule — Individual Premium Allocation", 14, y);
        y += 6;
        autoTable(doc, {
          startY: y,
          margin: { left: 14, right: 14 },
          head: [["Reg Number","Make","Model","Year","Sum Insured","Monthly Prem","Annual Prem"]],
          body: cohort.priced_trailers.map(v => [
            v.registration || "—",
            v.make || "—",
            (v.model || "—").substring(0, 25),
            v.year ? String(v.year) : "—",
            `R${(v.insured_value || 0).toLocaleString("en-ZA")}`,
            fmt(v.monthly),
            fmt(v.annual),
          ]),
          foot: [[
            { content: `TOTAL (${cohort.priced_trailers.length} trailers)`, colSpan: 4, styles: { fontStyle: "bold" } },
            { content: `R${(cohort.trailer_total_si || 0).toLocaleString("en-ZA")}`, styles: { fontStyle: "bold" } },
            { content: fmt(cohort.cohort_monthly) + "/mo", styles: { fontStyle: "bold" } },
            { content: fmt(cohort.cohort_annual), styles: { fontStyle: "bold" } },
          ]],
          headStyles: { fillColor: NAVY, textColor: WHITE, fontSize: 8 },
          footStyles: { fillColor: [232, 237, 245], textColor: NAVY, fontSize: 8 },
          bodyStyles: { fontSize: 8 },
          alternateRowStyles: { fillColor: [245, 247, 250] },
          theme: "grid",
        });
        y = doc.lastAutoTable.finalY + 8;
      }
    } else {
      // GIT breakdown
      y = addKeyValueTable(doc, y, [
        ["Vehicle Count", String(cohort.vehicle_count || 0)],
        ["Load Limit / Vehicle", fmt(cohort.load_limit_per_vehicle)],
        ["Asset Class", (cohort.asset_class || "").replace(/_/g, " ")],
        ["Commodity Type", (cohort.commodity_type || "").replace(/_/g, " ")],
        ["Base PVPM", fmt(cohort.base_pvpm)],
        ["Loaded PVPM", fmt(cohort.loaded_pvpm)],
        ["IoT Adjustment", cohort.iot_credit && cohort.iot_credit.total_credit != null ? (cohort.iot_credit.total_credit * 100).toFixed(0) + "%" : "—"],
        ["Final PVPM", fmt(cohort.final_pvpm)],
        ["Monthly Premium", fmt(cohort.cohort_monthly)],
        ["Annual Premium", fmt(cohort.cohort_annual)],
      ]);
    }
  });

  const referredCohorts = cohorts.filter((c) => c.status === "REFER");
  if (referredCohorts.length > 0) {
    if (y > 250) { doc.addPage(); y = 20; }
    y = addSectionTitle(doc, y, "Referred Cohorts (not included in premium)");
    doc.setFontSize(9);
    doc.setTextColor(...GREY);
    referredCohorts.forEach((c) => {
      doc.text(`• ${(c.asset_class || "").replace(/_/g, " ")} — ${c.vehicle_count || 0} vehicles — ${c.referral_reason || "Referred"}`, 16, y);
      y += 5;
    });
    y += 4;
  }

  if (y > 230) { doc.addPage(); y = 20; }
  y = addSectionTitle(doc, y, "Excess Structure (Section 4 — Confirmed)");
  y = addKeyValueTable(doc, y, [
    ["Own Damage", "10% of claim (min R7,500) or 6.5% of vehicle value, whichever greater"],
    ["Theft / Hijack", "15% of claim (min R7,500)"],
    ["Penalty Excess", "5% of claim (max R10,000) — night driving 23h00-04h00, driver <25yrs or licensed <3yrs, capsizing while tipping"],
    ["Tracking Requirement", "Approved Cat A or C device required for vehicles >= R200,000"],
    ["Settlement Basis", "First-loss basis, no average clause"],
  ]);

  addFooter(doc);
  doc.save(`ORCA_TelematiX_MultiCohort_Quote_${fleetName.replace(/\s+/g, "_")}_${new Date().toISOString().slice(0, 10)}.pdf`);
}
