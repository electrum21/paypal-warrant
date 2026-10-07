import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AgStudio, createWidgets } from "ag-studio-react";
import { loadDatasets, token } from "./warrant.js";
import { warrantTheme } from "./theme.js";
import { mandateGaugeWidget } from "./MandateGauge.jsx";
import { buildAi } from "./agent.js";
import "./studio.css";

const PROMPTS = [
  "Which buyer agents have the highest dispute rate, and why?",
  "Show disputes by recommended action as a donut chart",
  "Chart over-limit amounts by agent",
  "Which findings come up most often?",
];

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const ai = useMemo(() => { try { return buildAi(); } catch (e) { console.error("Agent setup failed; dashboard continues without it", e); return undefined; } }, []);

  const load = useCallback(() => {
    setError("");
    loadDatasets().then(setData).catch(e => setError(e.message));
  }, []);
  useEffect(load, [load]);

  // The custom widget is added to its own "Warrant" group in the widget menu.
  const widgets = useMemo(() => widgetConfig => createWidgets({
    additionalTypes: [mandateGaugeWidget],
    menu: [...widgetConfig.menu, { label: "Warrant", widgetIds: ["mandateGauge"] }],
  }), []);

  return (
    <div className="shell">
      <header className="bar">
        <div className="brand"><span className="mark">W</span><div><div className="eyebrow">PayPal sandbox companion</div><strong>Warrant Studio</strong></div></div>
        <nav>
          <button onClick={load}>Refresh data</button>
          <a href={`/admin?token=${encodeURIComponent(token)}`}>Approval screen</a>
        </nav>
      </header>
      <details className="hint">
        <summary>{ai ? "Ask the Warrant analyst" : "Build a dashboard"}</summary>
        {ai
          ? <ul>{PROMPTS.map(p => <li key={p}>{p}</li>)}</ul>
          : <p>Drag fields from the data panel onto the canvas. Add the <b>Mandate gauge</b> from the Warrant group in the widget menu. The agent is off until an LLM adapter is installed (see web/src/openaiAdapter.js).</p>}
      </details>
      <main className="canvas">
        {error && <p className="problem" role="alert">Could not load data: {error}. Open this page as /studio/?token=YOUR_ADMIN_TOKEN.</p>}
        {!error && !data && <p className="muted">Loading...</p>}
        {data && <AgStudio data={data} mode="edit" theme={warrantTheme} widgets={widgets} ai={ai} />}
      </main>
    </div>
  );
}
