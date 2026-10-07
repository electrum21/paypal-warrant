import React, { useEffect, useState } from "react";
import { warrant } from "./warrant.js";
import { ACTION_COLOURS } from "./theme.js";

const LABEL = {
  contest: "Contest the dispute", offer_partial_refund: "Offer a partial refund",
  accept_claim: "Accept the claim", escalate_to_human: "Needs your review",
};
const money = (c, cur) => `${(c / 100).toFixed(2)} ${cur}`;

/**
 * Custom Studio widget: the signature visual of Warrant. For one dispute it shows what the agent spent against what the
 * user's signed mandate allowed, with the part above the limit in red, plus the decision the code reached and what
 * Channel3 said the product really was. It is read-only: approval happens in the approval screen, by a person.
 */
export function MandateGauge({ widgetApi }) {
  const [rows, setRows] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    widgetApi?.setDisplayState?.("displayed");
    warrant("/api/disputes")
      .then(r => { if (!live) return; const withMandate = r.filter(d => d.purchase && d.mandate); setRows(withMandate); setSelected(withMandate[0]?.id ?? null); })
      .catch(e => live && setError(e.message));
    return () => { live = false; };
  }, []);

  if (error) return <div className="gauge-box gauge-empty">Could not load disputes: {error}</div>;
  if (!rows) return <div className="gauge-box gauge-empty">Loading disputes...</div>;
  if (!rows.length) return <div className="gauge-box gauge-empty">No disputes with a signed mandate yet.</div>;

  const d = rows.find(x => x.id === selected) ?? rows[0];
  const { purchase: p, mandate: m } = d;
  const action = d.decision?.action ?? "escalate_to_human";
  const top = Math.max(p.amountCents, m.maxAmountCents);
  const pct = c => `${(c / top) * 100}%`;
  const over = p.amountCents > m.maxAmountCents;
  const verdict = d.productCheck?.categoryVerdict;

  return (
    <div className="gauge-box">
      <label className="gauge-pick">
        Dispute{" "}
        <select value={d.id} onChange={e => setSelected(Number(e.target.value))}>
          {rows.map(r => <option key={r.id} value={r.id}>{r.paypalDisputeId} ({money(r.purchase.amountCents, r.purchase.currency)})</option>)}
        </select>
      </label>
      <div className="gauge-decision" style={{ color: ACTION_COLOURS[action] }}>{LABEL[action]}</div>
      <div className="gauge-track" role="img"
           aria-label={`Purchase ${money(p.amountCents, p.currency)} against a mandate limit of ${money(m.maxAmountCents, m.currency)}`}>
        <div className="gauge-fill" style={{ width: pct(Math.min(p.amountCents, m.maxAmountCents)) }} />
        {over && <div className="gauge-over" style={{ left: pct(m.maxAmountCents), width: pct(p.amountCents - m.maxAmountCents) }} />}
        <div className="gauge-tick" style={{ left: pct(m.maxAmountCents) }} />
      </div>
      <div className="gauge-labels">
        <span>Purchase {money(p.amountCents, p.currency)}</span>
        <span>Mandate limit {money(m.maxAmountCents, m.currency)}</span>
      </div>
      <div className="gauge-meta">
        <span>{d.signatureValid ? "Signatures valid" : "Signature problem"}</span>
        {(d.findings ?? []).length > 0 && <span>{d.findings.map(f => f.code).join(", ")}</span>}
        {verdict && <span className={verdict === "not_allowed" ? "gauge-bad" : ""}>Channel3: {verdict.replace(/_/g, " ")}</span>}
        {d.precedents?.summary?.total > 0 && <span>{d.precedents.summary.total} similar past cases</span>}
      </div>
    </div>
  );
}

// Note: the widget definition below uses only documented fields (id, label, comp). Size defaults are Studio's own.
export const mandateGaugeWidget = { id: "mandateGauge", label: "Mandate gauge", comp: MandateGauge };
