import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgStudio, createWidgets } from "ag-studio-react";
import { loadDatasets, saveDashboardState, token } from "./warrant.js";
import { warrantTheme } from "./theme.js";
import { mandateGaugeWidget } from "./MandateGauge.jsx";
import { buildAi } from "./agent.js";
import dashboardState from "./dashboardState.json";
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
  const [exportMsg, setExportMsg] = useState("");
  const ai = useMemo(() => { try { return buildAi(); } catch (e) { console.error("Agent setup failed; dashboard continues without it", e); return undefined; } }, []);
  const studioRef = useRef(null);

  const load = useCallback(() => {
    setError("");
    loadDatasets().then(setData).catch(e => setError(e.message));
  }, []);
  useEffect(load, [load]);

  // Dev convenience: once the dashboard looks right (built by hand or by asking the agent), save its layout
  // so the next build opens pre-populated instead of a blank canvas - see dashboardState.json / warrant.js.
  const exportLayout = useCallback(() => {
    const api = studioRef.current?.api;
    if (!api) return;
    saveDashboardState(api.getState())
      .then(() => setExportMsg("Saved to web/src/dashboardState.json - rebuild to bake it in."))
      .catch(e => setExportMsg(`Export failed: ${e.message}`));
  }, []);

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
          <button onClick={exportLayout} title="Save the current layout as the page's pre-built starting state">Export layout</button>
          <a href={`/admin?token=${encodeURIComponent(token)}`}>Approval screen</a>
        </nav>
      </header>
      {exportMsg && <p className="muted" role="status">{exportMsg}</p>}
      <details className="hint">
        <summary>{ai ? "Ask the Warrant analyst" : "Build a dashboard"}</summary>
        {ai
          ? <ul>{PROMPTS.map(p => <li key={p}>{p}</li>)}</ul>
          : <p>Drag fields from the data panel onto the canvas. Add the <b>Mandate gauge</b> from the Warrant group in the widget menu. The agent needs a key on the server: set <code>GEMINI_API_KEY</code> and <code>STUDIO_LLM_PROVIDER=gemini</code> to use Warrant's built-in adapter, or install AG's own OpenAI adapter (see web/src/openaiAdapter.js) and set <code>STUDIO_LLM_API_KEY</code>.</p>}
      </details>
      <main className="canvas">
        {error && <p className="problem" role="alert">Could not load data: {error}. Open this page as /studio/?token=YOUR_ADMIN_TOKEN.</p>}
        {!error && !data && <p className="muted">Loading...</p>}
        {data && <AgStudio ref={studioRef} data={data} mode="edit" theme={warrantTheme} widgets={widgets} ai={ai} initialState={dashboardState ?? undefined} />}
      </main>
    </div>
  );
}
