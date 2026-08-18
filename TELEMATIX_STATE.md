# TelematiX Stream 2 Virtual Underwriter — Project State
*Living document. Read this at the start of every session before touching any code.*
*Last updated: August 2026 — post user-guide delivery, all 12 build items closed.*

---

## 1. What is this project?

A browser-based risk-scoring and premium-rating tool for South African commercial motor underwriters.
Built as a React/JSX single-page app (Vite build system). All computation is client-side — no backend.

- **Live URL:** https://telematix-rater.netlify.app
- **GitHub repo:** https://github.com/toeliep/virtual-underwriter
- **GitHub user:** toeliep
- **Last pushed commit:** 0314751 (on `main`)
- **App version string (internal):** v8.1.3

**Deploy command (always manual via Netlify CLI, NOT auto from GitHub):**
```
cd rater-app
netlify deploy --prod --dir=dist
```

---

## 2. File structure (inside `rater-app/src/`)

| File | Role |
|---|---|
| `TelematixRater.jsx` | Main monolith (~3 200 lines). All tabs, scoring engines, UI. |
| `MultiCohortView.jsx` | Multi-Cohort tab component (~1 200 lines). Imported by TelematixRater. |
| `plantAgriEngine.js` | Plant and Agri rating factor functions. Imported by MultiCohortView. |
| `orcaUnderwritingRules.js` | ORCA gate logic. Imported by MultiCohortView. |
| `generateQuotePDF.js` | PDF quote generation helpers. |

**Working copies in Claude's session** (always check these are current before editing):
- `/tmp/telematix/TelematixRater_bugs.jsx`
- `/tmp/telematix/MultiCohortView_bugs.jsx`

**Workflow for deploying changes:**
1. Edit the working copies in `/tmp/telematix/`
2. Zip the changed files and send to Toelie via SendUserFile
3. Toelie saves to `rater-app/src/`, saves, Vite hot-reloads
4. Toelie runs `netlify deploy --prod --dir=dist`
5. Toelie confirms "live"

---

## 3. Lines of business and rating engines

| Asset class (code) | Display name | Engine | Notes |
|---|---|---|---|
| `hcv_general_freight` | HCV General Freight | HCV 10-factor | |
| `fuel_hazmat_tanker` | Fuel / Hazmat Tanker | HCV 10-factor | |
| `minerals_bulk_long_haul` | Minerals / Bulk Long-Haul | HCV 10-factor | |
| `fmcg_distribution` | FMCG Distribution | HCV 10-factor | |
| `bulk_liquids_non_hazmat` | Bulk Liquids (non-hazmat) | HCV 10-factor | |
| `yellow_metal_plant` | Yellow Metal / Plant | Plant 2.0% base | |
| `agricultural_equipment` | Agricultural Equipment | Agri 1.6% base | |
| `irrigation_system` | Irrigation Systems | **Referral-only** | Frans Aug 2026 |
| `livestock` | Livestock | **Referral-only** | Frans Aug 2026 |
| GIT classes | (multiple — via commodity dropdown) | GIT PVPM bands | Hollard table |

---

## 4. HCV engine — key constants

### Telematics weights (`HCV_TELEMATICS_WEIGHTS`)
```js
fatigue_hos: 0.20, speeding: 0.15, cellphone_usage: 0.15,
safety_belt_compliance: 0.10, driver_behaviour_composite: 0.10,
distance_index: 0.08, device_integrity: 0.07,
time_on_road: 0.03, night_driving_ratio: 0.02
```
Static questionnaire (7-item): 10% weight blended in when all 7 items supplied.

### Scoring formula
`combined = weightedScore + concealmentAddition + questionnairePenalty + trendAddition`

Concealment: >200 events → +30; >100 → +15.
Trend modifiers: improving_strongly −15%, improving_slightly −5%, stable 0, deteriorating_slightly +10%, deteriorating_3plus_months +20%.

### Rating factor from combined score
| Score ≤ | Factor |
|---|---|
| 25 | 0.70 |
| 45 | 0.95 |
| 65 | 1.40 |
| 85 | 1.90 |
| >85 | 2.50 |

### Profiles (Frans-confirmed: 3 profiles, not 4)
- Profile A: factor ≤ 0.95 (score ≤ 45)
- Profile B: factor 1.40 (score 46–65) → CONDITIONAL ACCEPT
- Profile C / DECLINE: factor ≥ 1.90 (score > 65) → DECLINE

### Auto-decline triggers (HCV)
- Combined score > 100
- avg_km_per_vehicle_month > 16 000 (illegal HoS for single driver)
- device_concealment_events_per_month > 200
- speeding > 60 AND fatigue_hos > 80 simultaneously

### HCV data-source qualifier (Frans-confirmed Aug 2026 — TelematiX_Ingestion_Matrix.xlsx)
```js
const HCV_QUALIFIER = {
  none:      { factor: 1.40, coverage: 0.0,   label: "No telematics — Profile B cap" },
  oem_only:  { factor: 1.40, coverage: 0.612, label: "Fleetboard/OEM only — 61.2% coverage, Profile B cap" },
  oem_video: { factor: 0.70, coverage: 0.962, label: "Fleetboard + video — 96.2% coverage, Profile A eligible" },
}
```
Applied as a final multiplier to cohort_monthly and cohort_annual in MultiCohortView.
Profile A cap: only `oem_video` qualifies. `none` and `oem_only` → capped at Profile B regardless of score.

### Manufacturer loadings
mercedes_benz 0%, volvo −3%, freightliner −10%, scania +14%, faw +10%, man/daf +8%, western_star +15%

### Age band loadings
under_3yr +5%, 3–5yr +12%, 6–8yr +22%, 9–11yr +28%, 12–15yr +15%, over_15yr +20%

---

## 5. GIT engine — key constants

### PVPM bands (Hollard Trucking Underwriting Guide, Section 5.1)
```
R50k → R350, R100k → R450, R150k → R500, R200k → R550,
R250k → R650, R300k → R700, R350k → R750, R400k → R800,
R450k → R850, R500k → R900, R750k → R1150, R1m → R1450,
R1.25m → R1700, R1.5m → R1950
```
- Below R50k: requires management manual PVPM override (Frans-confirmed 25 Jul 2026)
- Above R1.5m: **referral-only** — no published Hollard rate

### Key thresholds
- `GIT_RMP1_THRESHOLD_RAND = 1_000_000` — loads above R1m require RMP-1 minimum security (Frans-confirmed)
- `GIT_REFERRAL_LOAD_LIMIT_WESTERN_CAPE = 1_500_000`
- `GIT_REFERRAL_LOAD_LIMIT_OTHER_ZONES = 1_000_000`
- `GIT_LOSS_RATIO_REFERRAL_THRESHOLD_PCT = 65.0`
- `GIT_MIN_ANNUAL_PREMIUM = 5_000`

### IoT credits (max cap −40%)
gps_realtime −15%, geofencing −10%, driver_behaviour_monitoring −12%, fatigue_sensor −8%,
cargo_seal_sensors −10%, temp_logger −8%, load_sensor −10%, panic_button −5%, dashcam −5%.
No IoT penalty: +20%.

### Excluded commodities (referral, not hard decline)
antiques, ammunition/explosives, bullion/cash, cameras/cellphones, prepaid cards, computers,
cobalt, copper (any form), non-ferrous metals, gold/silver/jewellery, documents/specie,
bloodstock/game, tobacco.

### Geographic zone loadings
western_cape 1.0×, medium_risk 1.15×, gauteng_high_risk 1.30×

---

## 6. Plant engine

- Base rate: **2.0% p.a.** of declared machine replacement value
- `computePlantRatingFactor()` in `plantAgriEngine.js`
- Data-source options: `oemOnly` / `oemSvr`
- If factor ≥ 2.0 (data coverage < 50%): REFER
- Minimum annual premium: R5 000

---

## 7. Agri engine

- Base rate: **1.6% p.a.** of declared value
- `computeAgriRatingFactor()` in `plantAgriEngine.js`
- Same data-source credits as Plant
- **Referral-only types:** `irrigation_system`, `livestock` — gate fires at top of `priceAgriCohort()`
- Minimum annual premium: R5 000

---

## 8. Tab structure (TelematixRater.jsx)

| Tab | Name | Key component/view |
|---|---|---|
| 1 | Telematix Report | `TelematixReportView` — uploads RMS report, runs `scoreFleet()`, displays verdict |
| 2 | Fleet Information | `FleetInformationView` — dual document intake (fleet doc OR RMS report), HCV fields + qualifier, GIT fields, static questionnaire |
| 3 | Multi-Cohort Pricing | `<MultiCohortView>` — cohort management, all asset classes, pricing per cohort |

**HCV Rating and GIT Quoting tabs were retired** — pricing now exclusively through Multi-Cohort.

---

## 9. Dual document intake (Tab 2)

`FleetInformationView` accepts PDF/image uploads. The AI extraction prompt detects document type:
- **`FLEET_DOCUMENT`** → maps fleet_name, vehicle_count, avg_km, GIT sum-insured fields
- **`RMS_REPORT`** → maps all 10 HCV behavioural score fields from `monthly_data[latest]`, runs `scoreFleet()` inline, displays verdict badge below upload zone

State variables: `extractDocType` (string), `rmsVerdict` (object from `scoreFleet()`).

Key field mapping for RMS route (from latest month):
`fatigue_hos`, `speeding`, `cellphone_usage`, `safety_belt_compliance`,
`driver_behaviour_composite`, `distance_index`, `device_integrity`, `time_on_road`,
`night_driving_ratio`, `device_covered_count → device_concealment_events_per_month`

---

## 10. ORCA gates (orcaUnderwritingRules.js)

Key gates:
- **Tracking gate** — GPS required above certain load limits
- **Settlement basis** — GIT cover type determination
- **Exclusion classifier** — maps commodity to exclusion status
- `checkTrackingGate()`, `determineGitCoverTier()`, `classifyExclusion()` imported into MultiCohortView

---

## 11. Key confirmed decisions (Frans)

| # | Decision | Answer | Date |
|---|---|---|---|
| 1 | 3 vs 4 risk profiles | **3 profiles** (A, B, C) — Slide 6 is correct | Aug 2026 |
| 2 | "400% base rate" on Slide 4 | **Slide error — discard** | Aug 2026 |
| 3 | Irrigation systems + livestock | **Referral-only** — no Stream 2 rating methodology | Aug 2026 |
| 4 | HCV data-source qualifier options | **3 options:** none / oem_only / oem_video; factors 1.40 / 1.40 / 0.70; coverage 0% / 61.2% / 96.2% | Aug 2026 |
| 5 | Below-R50k GIT load limit | **Management manual PVPM override** allowed | 25 Jul 2026 |
| 6 | RMP-1 mandate threshold | **R1 000 000 per load** — eligibility gate only, not rating change | Jul 2026 |
| 7 | OFF COVER verdict | **Retired** — consolidated to DECLINE | 9 Jul 2026 |

---

## 12. Build items — complete status

| # | Item | Status |
|---|---|---|
| 1 | Plant/Agri correctly wired to UI | ✅ Done — live |
| 2 | HCV data-source qualifier (3-option) | ✅ Done — live |
| 3 | Pricing through Multi-Cohort only (retire HCV Rating + GIT Quoting tabs) | ✅ Done — live |
| 4 | Fleet Information input UI (telematics scores + questionnaire fields) | ✅ Done — live |
| 5 | Telematix Report merged into Fleet Information dual intake | ✅ Done — live |
| 6 | Leading zero bug on numeric inputs | ✅ Done — live |
| 7 | Multi-Cohort referred-cohort vehicle count (was silently dropping) | ✅ Done — live |
| 8 | Soft warning for implausibly large sum-insured inputs | ✅ Done — live |
| 9 | GitHub catch-up (commit 0314751 pushed to main) | ✅ Done |
| 10 | 3 vs 4 risk profiles — confirmed with Frans | ✅ Resolved |
| 11 | 400% base rate anomaly — confirmed with Frans | ✅ Resolved |
| 12 | Irrigation systems + livestock referral-only | ✅ Done — live |

**Pending items: None.** App is feature-complete per the agreed build list.

---

## 13. Deliverables produced

| File | Location | Notes |
|---|---|---|
| `TelematiX_Underwriter_Guide.pdf` | Toelie's Downloads folder | 19-page full underwriter reference guide, v8.1, Aug 2026 |
| Various `.zip` patch files | `/tmp/telematix/` (session only) | Delivered to Toelie per item |

---

## 14. Session context tips

- Always read this file first at the start of a new session
- Working copies of JSX files are in `/tmp/telematix/` — re-read them before editing
- The repo is at `https://github.com/toeliep/virtual-underwriter` — clone if needed to verify state
- Deploy is manual: `netlify deploy --prod --dir=dist` from `rater-app/`
- Never auto-push to GitHub without Toelie confirming — she runs the push herself from CMD
- Toelie's machine: Windows, username `Toelie`, Downloads at `C:\Users\Toelie\Downloads`
