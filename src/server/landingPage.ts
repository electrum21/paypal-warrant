// A single entry point so a visitor never has to juggle several separate URLs: every other page
// (buyer, merchant admin, Studio dashboard) is reachable from here, with the admin token already
// filled in when one is configured.
export function landingPageHtml(token: string | undefined): string {
  const q = token ? `?token=${encodeURIComponent(token)}` : "";
  const tokenNote = token
    ? ""
    : `<p class="note">Set <code>ADMIN_TOKEN</code> (or <code>JUDGE_TOKEN</code>) in your environment to fill in the admin and Studio links automatically.</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Warrant</title>
<style>
:root{--paypal-blue:#003087;--paypal-sky:#0070ba;--paypal-gold:#ffc439;--ink:#14213d;--mute:#5b6674;--paper:#f5f7fb;--panel:#fff;--line:#d3dae1}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header{background:linear-gradient(135deg,var(--paypal-blue),#001a4d);color:#fff;padding:48px 24px 40px;text-align:center}
.mark{width:56px;height:56px;border-radius:50%;background:#fff;color:var(--paypal-blue);display:grid;place-items:center;font-weight:800;font-size:28px;margin:0 auto 16px}
.eyebrow{letter-spacing:.14em;text-transform:uppercase;font-size:12px;color:var(--paypal-gold);font-weight:700}
h1{margin:10px 0 6px;font-size:36px}
header p{margin:0;color:#c9d6ef;font-size:16px}
main{max-width:860px;margin:-20px auto 48px;padding:0 20px}
.cards{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
a.card{display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px;text-decoration:none;color:inherit;box-shadow:0 1px 3px rgba(20,33,61,.08);transition:box-shadow .15s,transform .15s}
a.card:hover{box-shadow:0 8px 24px rgba(20,33,61,.14);transform:translateY(-2px)}
.tag{display:inline-block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;color:var(--paypal-sky);margin-bottom:8px}
a.card h2{margin:0 0 8px;font-size:20px;line-height:1.25;color:var(--ink);min-height:2.5em}
a.card p{margin:0;color:var(--mute);font-size:14px}
.row{display:flex;justify-content:space-between;align-items:center;margin:40px 0 18px}
.row h3{margin:0;font-size:14px;letter-spacing:.06em;text-transform:uppercase;color:var(--mute)}
.links{display:flex;gap:18px;flex-wrap:wrap;font-size:14px}
.links a{color:var(--paypal-sky)}
.note{background:#fff7e0;border:1px solid #ffdd8a;border-radius:10px;padding:14px 16px;font-size:14px;margin-top:28px}
.note code{background:#00000012;padding:1px 5px;border-radius:4px}
footer{text-align:center;color:var(--mute);font-size:13px;padding:0 20px 40px}
</style></head>
<body>
<header>
  <div class="mark">W</div>
  <div class="eyebrow">PayPal Sandbox Companion</div>
  <h1>Warrant</h1>
  <p>Dispute defense for merchants selling to AI shopping agents</p>
</header>
<main>
  <div class="cards">
    <a class="card" href="/user">
      <div class="tag">Buyer</div>
      <h2>Shopping permission</h2>
      <p>Sign in with PayPal, set a spending limit, and watch the agent shop autonomously. No token needed.</p>
    </a>
    <a class="card" href="/admin${q}">
      <div class="tag">Merchant</div>
      <h2>Dispute approval screen</h2>
      <p>The real dispute queue, the deterministic finding, the AI-drafted note, one click to approve or dismiss.</p>
    </a>
    <a class="card" href="/studio${q}">
      <div class="tag">Merchant</div>
      <h2>Studio dashboard</h2>
      <p>Five pre-built charts, plus a chat agent that can query live data and build new ones on request.</p>
    </a>
  </div>
  ${tokenNote}
  <div class="row"><h3>More</h3></div>
  <div class="links">
    <a href="/health">/health — feature flags for this deployment</a>
    <a href="https://github.com/electrum21/paypal-warrant">Source on GitHub</a>
    <a href="https://youtu.be/FAMkX6030SE">Demo video</a>
  </div>
</main>
<footer>PayPal sandbox only — no real money ever moves.</footer>
</body></html>`;
}
