"""
extract_report.py
------------------
Phase 1 extraction pipeline: PDF in -> structured JSON out -> scored verdict.

Usage:
    python extract_report.py "path\to\report.pdf"

Requires:
    pip install anthropic --break-system-packages
    ANTHROPIC_API_KEY environment variable already set (setx, done in CMD)
"""

import sys
import os
import json
import base64
from pathlib import Path

try:
    import anthropic
except ImportError:
    print("Missing dependency. Run this first:")
    print('    pip install anthropic --break-system-packages')
    sys.exit(1)

from telematix_scoring import FleetRecord, MonthlyBehaviouralInputs, score_fleet


EXTRACTION_SCHEMA_PROMPT = """You are a data extraction tool. You will be shown a PDF that is one of two \
document types used by a South African HCV/GIT insurance underwriter:

TYPE A: An RMS/LibroAssist "Transporter Risk Report" — a telematics/i-Cab risk report with \
monthly graphs and tables of driver behaviour scores.

TYPE B: An insurer policy schedule (e.g. a Lombard/Motorworld-style document) with GIT cover \
limits, premiums, and vehicle lists.

Identify which type the document is, then extract ONLY what is explicitly stated in the \
document. Do not infer, average, or estimate any number that is not directly printed or \
clearly readable from a labelled data table. If a value is only visible on a graph without \
an accompanying number, set it to null and note it in "low_confidence_fields" rather than \
guessing a pixel position.

CRITICAL: Never place a raw incident count into a "_score" field, or vice versa. If a report \
page only shows a 0-100 risk score with no exact number (unlabelled graph), the "_score" field \
is null. If a page separately shows a raw count table, populate the matching \
"_incident_count" field instead. These are never interchangeable.

Return ONLY valid JSON (no markdown fences, no prose before or after) in this exact shape:

{
  "document_type": "RMS_REPORT" or "POLICY_SCHEDULE",
  "transporter_or_insured_name": string,
  "report_or_schedule_date": string,
  "period_reviewed": string or null,
  "fleet_summary": {
    "avg_vehicles": number or null,
    "avg_km_per_vehicle_month": number or null,
    "combined_risk_score_latest": number or null
  },
  "monthly_data": [
    {
      "month": "YYYY-MM",
      "combined_score_reported": number or null,
      "distance_index": number or null,
      "speeding": number or null,
      "fatigue_hos": number or null,
      "cellphone_talking_score": number or null,
      "cellphone_texting_score": number or null,
      "safety_belt_score": number or null,
      "cellphone_talking_incident_count": number or null,
      "cellphone_texting_incident_count": number or null,
      "safety_belt_incident_count": number or null,
      "device_covered_count": number or null,
      "not_focussing_count": number or null,
      "severe_driving_count": number or null
    }
  ],
  "static_risk": {
    "score": number or null,
    "questions_completed": string or null,
    "note": string or null
  },
  "policy_details": {
    "insurer": string or null,
    "policy_number": string or null,
    "git_limit_per_vehicle": number or null,
    "vehicle_count": number or null,
    "pvpm_rate": number or null,
    "monthly_premium": number or null
  },
  "low_confidence_fields": [string],
  "extraction_notes": string
}

Only populate "monthly_data" table fields with real per-month values where the source \
document gives an exact number (e.g. from a data table, not a bar chart you're eyeballing). \
If the document only gives fleet-level summary figures, leave monthly_data as an empty list \
and rely on fleet_summary instead."""


def extract_pdf(pdf_path: str) -> dict:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ANTHROPIC_API_KEY not found in environment. Run the setx command in CMD, "
              "close and reopen CMD, then try again.")
        sys.exit(1)

    client = anthropic.Anthropic(api_key=api_key)

    pdf_bytes = Path(pdf_path).read_bytes()
    pdf_b64 = base64.standard_b64encode(pdf_bytes).decode("utf-8")

    message = client.messages.create(
        model="claude-sonnet-5",
        max_tokens=8000,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "document",
                        "source": {
                            "type": "base64",
                            "media_type": "application/pdf",
                            "data": pdf_b64,
                        },
                    },
                    {"type": "text", "text": EXTRACTION_SCHEMA_PROMPT},
                ],
            }
        ],
    )

    raw_text = "".join(block.text for block in message.content if block.type == "text")
    raw_text = raw_text.strip()
    if raw_text.startswith("```"):
        raw_text = raw_text.strip("`")
        if raw_text.startswith("json"):
            raw_text = raw_text[4:]
    try:
        return json.loads(raw_text)
    except json.JSONDecodeError as e:
        print("Extraction did not return valid JSON. Raw response was:")
        print(raw_text)
        raise e


def build_fleet_record(extracted: dict) -> FleetRecord:
    """Converts extracted JSON into a FleetRecord. Falls back to the fleet-level
    summary's combined score for the most recent month if the monthly table
    itself didn't have an exact reported figure (common when RMS's own graph
    is unlabelled but the intro paragraph still states the current score)."""
    name = extracted.get("transporter_or_insured_name", "Unknown Fleet")
    fs = extracted.get("fleet_summary", {})
    months = []

    if extracted.get("monthly_data"):
        for m in extracted["monthly_data"]:
            months.append(MonthlyBehaviouralInputs(
                fatigue_hos=m.get("fatigue_hos"),
                speeding=m.get("speeding"),
                cellphone_talking=m.get("cellphone_talking_score"),
                cellphone_texting=m.get("cellphone_texting_score"),
                safety_belt=m.get("safety_belt_score"),
                distance_index=m.get("distance_index"),
                concealment_events=m.get("device_covered_count"),
                combined_score_reported=m.get("combined_score_reported"),
                km_per_vehicle_month=fs.get("avg_km_per_vehicle_month"),
            ))
        # If the last month in the table has no exact combined score, but the
        # document's summary paragraph states one (e.g. "combined risk score
        # of 73/100"), use that as the latest point rather than discarding it.
        if months and months[-1].combined_score_reported is None:
            months[-1].combined_score_reported = fs.get("combined_risk_score_latest")
    else:
        months.append(MonthlyBehaviouralInputs(
            combined_score_reported=fs.get("combined_risk_score_latest"),
            km_per_vehicle_month=fs.get("avg_km_per_vehicle_month"),
        ))

    static = extracted.get("static_risk", {})
    return FleetRecord(
        name=name,
        static_risk_score=static.get("score"),
        static_risk_complete=(static.get("questions_completed") is None),
        months=months,
    )


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print('Usage: python extract_report.py "path\\to\\report.pdf"')
        sys.exit(1)

    pdf_path = sys.argv[1]
    print(f"Extracting: {pdf_path}")
    extracted = extract_pdf(pdf_path)

    out_path = Path(pdf_path).with_suffix(".extracted.json")
    out_path.write_text(json.dumps(extracted, indent=2))
    print(f"Saved extraction to: {out_path}")

    if extracted.get("low_confidence_fields"):
        print(f"\nLow-confidence / missing fields: {extracted['low_confidence_fields']}")
    print(f"Extraction notes: {extracted.get('extraction_notes', '(none)')}")

    if extracted.get("document_type") == "POLICY_SCHEDULE":
        print("\nThis is a policy schedule, not a risk report — nothing to score.")
        print(json.dumps(extracted.get("policy_details", {}), indent=2))
    else:
        fleet = build_fleet_record(extracted)
        result = score_fleet(fleet)
        print("\n" + "=" * 60)
        print(f"VERDICT for {fleet.name}: {result['verdict']}")
        print(f"Latest combined score: {result.get('latest_combined_score')}")
        if "triggers" in result:
            print(f"Triggers: {result['triggers']}")
        if "trend_detail" in result:
            print(f"Trend: {result['trend_detail']}")
        print("=" * 60)
