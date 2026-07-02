import React, { useState, useCallback, useRef } from "react";

// ---------------------------------------------------------------------------
// Deterministic scoring engine — JS port of telematix_scoring.py.
// Same rules, same honesty guarantee: never guesses a missing field, never
// silently defaults "no data" to "accept". This is the audit-trail layer;
// the LLM above it only extracts, it never computes a verdict.
// ---------------------------------------------------------------------------

function checkAutoDeclineTriggers(m) {
  const triggers = [];
  if (m.combined_score_used != null && m.combined_score_used > 100) {
    triggers.push("Combined risk score exceeds 100");
  }
  if (m.km_per_vehicle_month != null && m.km_per_vehicle_month > 16000) {
    triggers.push(
      `km/vehicle/month ${Math.round(m.km_per_vehicle_month)} exceeds 16,000 (illegal HoS for single driver)`
    );
  }
  if (m.device_covered_count != null && m.device_covered_count > 200) {
    triggers.push(`Device concealment events ${m.device_covered_count}/mo exceeds 200`);
  }
  if (m.speeding != null && m.fatigue_hos != null && m.speeding > 60 && m.fatigue_hos > 80) {
    triggers.push(`Speeding (${m.speeding}) AND Fatigue (${m.fatigue_hos}) both breach simultaneously`);
  }
  return triggers;
}

function checkRisingTrendReferral(scores, bandLow = 66, bandHigh = 85) {
  const real = scores.filter((s) => s != null);
  if (real.length < 4) return null;
  const last4 = real.slice(-4);
  const strictlyRising = last4.every((v, i) => i === 0 || v > last4[i - 1]);
  const current = last4[last4.length - 1];
  const inAmber = current >= bandLow && current <= bandHigh;
  if (strictlyRising && inAmber) {
    return `4-month rising trend (${last4[0].toFixed(0)} -> ${last4[3].toFixed(0)}) in Amber band, no plateau — refer for underwriting review per trend rule`;
  }
  return null;
}

function scoreFleet(extracted) {
  const fs = extracted.fleet_summary || {};
  let months = (extracted.monthly_data || []).map((m) => ({
    ...m,
    combined_score_used: m.combined_score_reported,
    km_per_vehicle_month: fs.avg_km_per_vehicle_month,
  }));

  if (months.length === 0) {
    months = [
      {
        combined_score_used: fs.combined_risk_score_latest,
        km_per_vehicle_month: fs.avg_km_per_vehicle_month,
      },
    ];
  } else if (months[months.length - 1].combined_score_used == null) {
    months[months.length - 1].combined_score_used = fs.combined_risk_score_latest;
  }

  const monthlyResults = months.map((m) => ({
    ...m,
    triggers: checkAutoDeclineTriggers(m),
  }));

  const latest = monthlyResults[monthlyResults.length - 1];
  const firstBreachIdx = monthlyResults.findIndex((m) => m.triggers.length > 0);

  let verdict, detail;

  if (latest.combined_score_used == null) {
    verdict = "INSUFFICIENT DATA";
    detail = "No usable combined score could be extracted from this document — cannot verify.";
  } else if (firstBreachIdx !== -1) {
    // Any historical breach routes through the recovery clause. Without a
    // persistent case file (this is a stateless single-document demo), we
    // can only check clean months WITHIN this document's own history —
    // matches the Python engine's logic when no external breach record exists.
    const cleanSince = monthlyResults.slice(firstBreachIdx + 1);
    let cleanStreak = 0;
    for (const m of cleanSince) {
      if (m.triggers.length === 0) cleanStreak += 1;
      else cleanStreak = 0;
    }
    verdict = "OFF COVER";
    detail =
      cleanStreak > 0
        ? `Breach on record (month ${firstBreachIdx + 1}); ${cleanStreak} clean month(s) since, but recovery requires 3+ clean months AND documented intervention AND next annual review — conditions not yet confirmed met.`
        : `Breach on record (month ${firstBreachIdx + 1}), fleet has not yet recorded a clean month since.`;
  } else if (latest.triggers.length > 0) {
    verdict = "DECLINE";
    detail = latest.triggers.join("; ");
  } else {
    const trend = checkRisingTrendReferral(monthlyResults.map((m) => m.combined_score_used));
    if (trend) {
      verdict = "REFER";
      detail = trend;
    } else {
      verdict = "ACCEPT";
      detail = "No auto-decline trigger fired, no adverse sustained trend detected.";
    }
  }

  return { verdict, detail, latest, monthlyResults, firstBreachIdx };
}

// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `You are a data extraction tool. You will be shown a PDF that is one of two document types used by a South African HCV/GIT insurance underwriter:

TYPE A: An RMS/LibroAssist "Transporter Risk Report" — a telematics/i-Cab risk report with monthly graphs and tables of driver behaviour scores.
TYPE B: An insurer policy schedule with GIT cover limits, premiums, and vehicle lists.

Extract ONLY what is explicitly stated in the document. Do not infer, average, or estimate any number that is not directly printed or clearly readable from a labelled data table. If a value is only visible on a graph without an accompanying printed number, set it to null and note it in "low_confidence_fields" rather than guessing.

CRITICAL: Never place a raw incident count into a "_score" field, or vice versa. If a page only shows a 0-100 risk score with no exact number, the score field is null. If a page separately shows a raw count table, use the matching "_count" field instead. These are never interchangeable.

Return ONLY valid JSON (no markdown fences, no prose) in this exact shape:
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
      "device_covered_count": number or null
    }
  ],
  "static_risk": { "score": number or null, "note": string or null },
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
}`;

const VERDICT_STYLES = {
  ACCEPT: { ink: "#3D6B4F", label: "ACCEPT" },
  DECLINE: { ink: "#B23A2E", label: "DECLINE" },
  REFER: { ink: "#B5762A", label: "REFER" },
  "OFF COVER": { ink: "#B23A2E", label: "OFF COVER" },
  "INSUFFICIENT DATA": { ink: "#5C6570", label: "INSUFFICIENT DATA" },
};

function StampBadge({ verdict }) {
  const style = VERDICT_STYLES[verdict] || VERDICT_STYLES["INSUFFICIENT DATA"];
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        border: `4px solid ${style.ink}`,
        color: style.ink,
        borderRadius: "6px",
        padding: "14px 28px",
        transform: "rotate(-3deg)",
        fontFamily: "'IBM Plex Mono', monospace",
        fontWeight: 700,
        fontSize: "1.5rem",
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        boxShadow: `inset 0 0 0 1px ${style.ink}`,
        background: "rgba(255,255,255,0.4)",
      }}
    >
      {style.label}
    </div>
  );
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function TelematixRater() {
  const [status, setStatus] = useState("idle"); // idle | reading | extracting | done | error
  const [fileName, setFileName] = useState(null);
  const [extracted, setExtracted] = useState(null);
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const inputRef = useRef(null);

  const processFile = useCallback(async (file) => {
    if (!file || file.type !== "application/pdf") {
      setStatus("error");
      setErrorMsg("Please provide a PDF file — that's the only format this reads.");
      return;
    }
    setFileName(file.name);
    setStatus("reading");
    setExtracted(null);
    setResult(null);
    setErrorMsg(null);

    try {
      const b64 = await fileToBase64(file);
      setStatus("extracting");

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 8000,
          messages: [
            {
              role: "user",
              content: [
                { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } },
                { type: "text", text: EXTRACTION_PROMPT },
              ],
            },
          ],
        }),
      });

      const data = await response.json();
      let rawText = (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      rawText = rawText.trim();
      if (rawText.startsWith("```")) {
        rawText = rawText.replace(/^```(json)?/, "").replace(/```$/, "").trim();
      }

      const json = JSON.parse(rawText);
      setExtracted(json);

      if (json.document_type === "POLICY_SCHEDULE") {
        setResult({ policySchedule: true });
      } else {
        setResult(scoreFleet(json));
      }
      setStatus("done");
    } catch (err) {
      setStatus("error");
      setErrorMsg(err.message || "Extraction failed. Try again, or try a smaller/clearer PDF.");
    }
  }, []);

  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      processFile(file);
    },
    [processFile]
  );

  const reset = () => {
    setStatus("idle");
    setFileName(null);
    setExtracted(null);
    setResult(null);
    setErrorMsg(null);
    setShowRaw(false);
  };

  return (
    <div
      style={{
        fontFamily: "'Inter', -apple-system, sans-serif",
        background: "#FAF7F0",
        color: "#14213D",
        minHeight: "100%",
        padding: "0",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@500;700&family=Fraunces:wght@600;700&display=swap');
        .tx-root * { box-sizing: border-box; }
        .tx-upload-zone:focus-visible { outline: 2px solid #14213D; outline-offset: 3px; }
        .tx-btn:focus-visible { outline: 2px solid #14213D; outline-offset: 2px; }
        @media (prefers-reduced-motion: reduce) {
          .tx-root * { transition: none !important; animation: none !important; }
        }
      `}</style>

      <div className="tx-root" style={{ maxWidth: "760px", margin: "0 auto", padding: "40px 24px 64px" }}>
        {/* Header */}
        <div style={{ marginBottom: "36px", borderBottom: "2px solid #14213D", paddingBottom: "20px" }}>
          <div
            style={{
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: "0.75rem",
              letterSpacing: "0.15em",
              color: "#B5762A",
              textTransform: "uppercase",
              marginBottom: "6px",
            }}
          >
            TelematiX — Stream 2 Virtual Underwriter
          </div>
          <h1
            style={{
              fontFamily: "'Fraunces', serif",
              fontSize: "1.9rem",
              fontWeight: 700,
              margin: 0,
              lineHeight: 1.15,
            }}
          >
            HCV / GIT Fleet Risk Rater
          </h1>
          <p style={{ color: "#5C6570", fontSize: "0.95rem", marginTop: "8px", marginBottom: 0 }}>
            Drop a transporter risk report or GIT policy schedule. Extraction and scoring run separately —
            the rating is never guessed by the model.
          </p>
        </div>

        {/* Upload zone */}
        {status === "idle" || status === "error" ? (
          <div
            className="tx-upload-zone"
            role="button"
            tabIndex={0}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            style={{
              border: `2px dashed ${dragOver ? "#B5762A" : "#14213D"}`,
              borderRadius: "8px",
              padding: "56px 24px",
              textAlign: "center",
              cursor: "pointer",
              background: dragOver ? "rgba(181,118,42,0.06)" : "transparent",
              transition: "all 0.15s ease",
            }}
          >
            <div style={{ fontSize: "2rem", marginBottom: "10px" }}>📄</div>
            <div style={{ fontWeight: 600, fontSize: "1.05rem" }}>
              Drop a PDF here, or click to choose one
            </div>
            <div style={{ color: "#5C6570", fontSize: "0.85rem", marginTop: "6px" }}>
              RMS transporter risk report or insurer GIT policy schedule
            </div>
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf"
              style={{ display: "none" }}
              onChange={(e) => processFile(e.target.files?.[0])}
            />
            {status === "error" && (
              <div
                style={{
                  marginTop: "20px",
                  color: "#B23A2E",
                  fontSize: "0.9rem",
                  fontFamily: "'IBM Plex Mono', monospace",
                }}
              >
                {errorMsg}
              </div>
            )}
          </div>
        ) : null}

        {/* Loading state */}
        {(status === "reading" || status === "extracting") && (
          <div style={{ textAlign: "center", padding: "48px 0" }}>
            <div
              style={{
                width: "36px",
                height: "36px",
                margin: "0 auto 18px",
                border: "3px solid #E4DCC9",
                borderTopColor: "#B5762A",
                borderRadius: "50%",
                animation: "spin 0.8s linear infinite",
              }}
            />
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "0.85rem", color: "#5C6570" }}>
              {status === "reading" ? "Reading " + fileName : "Extracting from document — this can take a minute on long schedules..."}
            </div>
          </div>
        )}

        {/* Results */}
        {status === "done" && result && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "24px" }}>
              <div>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "0.75rem", color: "#5C6570", marginBottom: "4px" }}>
                  {fileName}
                </div>
                <div style={{ fontSize: "1.1rem", fontWeight: 600 }}>
                  {extracted?.transporter_or_insured_name || "Unknown"}
                </div>
              </div>
              <button className="tx-btn" onClick={reset} style={resetBtnStyle}>
                Rate another
              </button>
            </div>

            {result.policySchedule ? (
              <PolicyScheduleView extracted={extracted} />
            ) : (
              <FleetVerdictView extracted={extracted} result={result} />
            )}

            <button
              className="tx-btn"
              onClick={() => setShowRaw((s) => !s)}
              style={{ ...resetBtnStyle, marginTop: "28px", fontSize: "0.8rem" }}
            >
              {showRaw ? "Hide raw extraction JSON" : "Show raw extraction JSON"}
            </button>
            {showRaw && (
              <pre
                style={{
                  marginTop: "12px",
                  background: "#14213D",
                  color: "#E4DCC9",
                  padding: "16px",
                  borderRadius: "6px",
                  fontSize: "0.72rem",
                  overflowX: "auto",
                  fontFamily: "'IBM Plex Mono', monospace",
                }}
              >
                {JSON.stringify(extracted, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const resetBtnStyle = {
  background: "transparent",
  border: "1.5px solid #14213D",
  color: "#14213D",
  borderRadius: "5px",
  padding: "8px 16px",
  fontSize: "0.85rem",
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "'Inter', sans-serif",
};

function FleetVerdictView({ extracted, result }) {
  const fs = extracted.fleet_summary || {};
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "20px", marginBottom: "24px" }}>
        <StampBadge verdict={result.verdict} />
        <div>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "1.4rem", fontWeight: 700 }}>
            {result.latest.combined_score_used != null ? result.latest.combined_score_used.toFixed(0) : "—"}
          </div>
          <div style={{ fontSize: "0.75rem", color: "#5C6570" }}>Latest combined score</div>
        </div>
      </div>

      <div style={{ background: "#F1ECE0", borderRadius: "6px", padding: "16px 18px", marginBottom: "20px" }}>
        <div style={{ fontSize: "0.9rem", lineHeight: 1.5 }}>{result.detail}</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "10px", marginBottom: "22px" }}>
        <StatBox label="Avg vehicles" value={fs.avg_vehicles ?? "—"} />
        <StatBox label="Avg km/vehicle/mo" value={fs.avg_km_per_vehicle_month ?? "—"} />
      </div>

      {extracted.low_confidence_fields?.length > 0 && (
        <div style={{ marginBottom: "20px" }}>
          <SectionLabel>Fields not verifiable from this document</SectionLabel>
          <ul style={{ margin: "8px 0 0", paddingLeft: "18px", fontSize: "0.82rem", color: "#5C6570", lineHeight: 1.6 }}>
            {extracted.low_confidence_fields.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>
      )}

      {extracted.monthly_data?.length > 0 && (
        <div>
          <SectionLabel>Monthly audit trail</SectionLabel>
          <div style={{ overflowX: "auto", marginTop: "8px" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
              <thead>
                <tr style={{ borderBottom: "1.5px solid #14213D" }}>
                  <th style={thStyle}>Month</th>
                  <th style={thStyle}>Combined score</th>
                  <th style={thStyle}>Triggers</th>
                </tr>
              </thead>
              <tbody>
                {result.monthlyResults.map((m, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid #E4DCC9" }}>
                    <td style={tdStyle}>{m.month || `#${i + 1}`}</td>
                    <td style={{ ...tdStyle, fontFamily: "'IBM Plex Mono', monospace" }}>
                      {m.combined_score_used != null ? m.combined_score_used.toFixed(0) : "—"}
                    </td>
                    <td style={{ ...tdStyle, color: m.triggers.length ? "#B23A2E" : "#5C6570" }}>
                      {m.triggers.length ? m.triggers.join("; ") : "clean"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function PolicyScheduleView({ extracted }) {
  const p = extracted.policy_details || {};
  return (
    <div>
      <div
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: "0.75rem",
          color: "#B5762A",
          marginBottom: "16px",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        Policy schedule — not scored
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "10px" }}>
        <StatBox label="Insurer" value={p.insurer ?? "—"} />
        <StatBox label="Policy number" value={p.policy_number ?? "—"} />
        <StatBox label="GIT limit / vehicle" value={p.git_limit_per_vehicle ? `R${p.git_limit_per_vehicle.toLocaleString()}` : "—"} />
        <StatBox label="Vehicle count" value={p.vehicle_count ?? "—"} />
        <StatBox label="PVPM rate" value={p.pvpm_rate ? `R${p.pvpm_rate.toFixed(2)}` : "—"} />
        <StatBox label="Monthly premium" value={p.monthly_premium ? `R${p.monthly_premium.toLocaleString()}` : "—"} />
      </div>
    </div>
  );
}

function StatBox({ label, value }) {
  return (
    <div style={{ background: "#F1ECE0", borderRadius: "6px", padding: "12px 14px" }}>
      <div style={{ fontSize: "0.72rem", color: "#5C6570", marginBottom: "4px" }}>{label}</div>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: "0.95rem", fontWeight: 600 }}>{value}</div>
    </div>
  );
}

function SectionLabel({ children }) {
  return (
    <div
      style={{
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: "0.72rem",
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "#14213D",
        borderBottom: "1.5px solid #14213D",
        paddingBottom: "4px",
      }}
    >
      {children}
    </div>
  );
}

const thStyle = { textAlign: "left", padding: "8px 10px", fontWeight: 600, color: "#14213D" };
const tdStyle = { padding: "8px 10px" };
