# Virtual Underwriter — Test Log & Deferred Items

Tracks real-fleet test runs through extract_report.py / telematix_scoring.py, plus open schema/pipeline gaps. Append new entries as fleets are tested — don't overwrite history.

---

## Test Runs

### 2026-07-02 — Mystic Blue Trading 630 (PTY) LTD
- Source: Mystic Blue Risk Report.pdf (RMS/LibroAssist Transporter Risk Report)
- Verdict: ACCEPT — no trigger, no adverse trend
- Latest combined score: 46
- Expected (per test_fleets.py benchmark): ACCEPT — matches
- Notes: Monthly combined scores pulled cleanly from labelled graph (Aug 2024-Jul 2025). Driving-behaviour category graphs (distance index, speeding, fatigue, cellphone, safety belt) had no printed numeric labels — correctly left null rather than estimated.
- Schema gap identified: Source table (p.9) includes incident-count columns for curtains closed, objects in cab, and passengers — no matching field exists in the extraction schema yet. Did not affect this verdict. Open item — see below.

### 2026-07-02 — Silver Falls Trading CC
- Source: Silver Falls Trading.pdf (RMS/LibroAssist Transporter Risk Report)
- Verdict: OFF COVER — conditions not met
- Latest combined score: 109
- Expected (per test_fleets.py benchmark): OFF COVER — matches
- Notes: Extraction flagged two monthly values (Jun 2023, Aug 2023) as low-confidence — source chart rendering showed "105" visually overlapping an adjacent "1105" label, ambiguous which digits belonged to which data point. Manually verified against source PDF (Toelie, 2026-07-03): Jun = 105, Jul = 107, Aug = 105 — extraction was correct. Good validation of the low-confidence flagging behaviour: uncertain, said so, and was right.
- Incident-count table only covered May-Nov 2023 (Jan-Apr not present in source document) — correctly left null rather than backfilled.
- Static risk score: report explicitly stated no data available — correctly handled as absent, not defaulted.

---

## Open / Deferred Items

1. Schema missing three incident-count fields — curtains_closed_count, objects_in_cab_count, passengers_count appear in at least one real source report's table but have no corresponding field in the extraction JSON schema (EXTRACTION_SCHEMA_PROMPT in extract_report.py, and the matching prompt in telematix_rater.jsx). Not yet triggered a wrong verdict, but if a fleet ever breaches specifically on one of these, there's currently nowhere for that number to land. Needs a schema + scoring-engine decision from Frans on whether these matter to the rating, or are informational only.

2. Netlify hosting — API key architecture — telematix_rater.jsx currently calls api.anthropic.com directly from the browser with no key attached; this only works inside the Claude artifact sandbox. Needs a serverless proxy (Netlify Function) holding the key server-side before public deployment. (In progress — see hosting build.)

---

## Fleets Tested So Far
- Mystic Blue Trading 630 (ACCEPT) - DONE
- Silver Falls Trading CC (OFF COVER) - DONE
- Ruah Transport - not yet tested
- Akira Creative Solutions T/A Vukukhanya - not yet tested
- JKW Transport - not yet tested
- Any fleet not already in the test_fleets.py benchmark set (true out-of-sample test)