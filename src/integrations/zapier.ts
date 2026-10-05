export async function notifyZapier(webhookUrl: string | undefined, event: {
  type: string; disputeId: number; message: string; data?: unknown;
}): Promise<void> {
  if (!webhookUrl) return;
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "warrant", ...event }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Zapier webhook ${res.status}`);
}
