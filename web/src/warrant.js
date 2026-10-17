// Everything the Studio app asks of the Warrant server goes through here. All calls need the admin token,
// which the page reads from ?token= exactly like the /admin approval screen does.
export const token = new URLSearchParams(location.search).get("token") || "";

export async function warrant(path) {
  const res = await fetch(path, { headers: { "x-admin-token": token } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

/** Persists the dashboard layout (api.getState()) to web/src/dashboardState.json on the server, so a
 * rebuild bakes it in as the Studio page's initialState - see App.jsx's "Export layout" button. */
export async function saveDashboardState(state) {
  const res = await fetch("/studio-api/dashboard-state", {
    method: "POST",
    headers: { "x-admin-token": token, "content-type": "application/json" },
    body: JSON.stringify(state),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

/** The flat tables Studio charts. See src/analytics/datasets.ts for what each row means. */
export async function loadDatasets() {
  const d = await warrant("/api/analytics/datasets");
  return {
    sources: [
      { id: "disputes", data: d.disputes },
      { id: "agents", data: d.agents },
      { id: "orders", data: d.orders },
      { id: "agentSteps", data: d.agentSteps },
    ],
  };
}
