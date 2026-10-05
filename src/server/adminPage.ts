// Single self-contained page. All dynamic text goes through textContent (mandate descriptions are
// written by a third party, so nothing from the API is ever inserted as HTML).
export const adminPageHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Warrant: dispute responses</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/ag-grid-community/styles/ag-grid.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/ag-grid-community/styles/ag-theme-quartz.css">
<script src="https://cdn.jsdelivr.net/npm/ag-grid-community/dist/ag-grid-community.min.js"></script>
<style>
:root{--paypal-blue:#003087;--paypal-sky:#0070ba;--paypal-gold:#ffc439;--ink:#14213d;--mute:#5b6674;--paper:#f5f7fb;--panel:#fff;--line:#d3dae1;
--contest:#0f6e6e;--refund:#a86414;--accept:#a63a3a;--review:#55606e;--over:#c2453d}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
button,input,textarea{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--paypal-sky);outline-offset:2px}
.app{display:grid;grid-template-columns:420px minmax(0,1fr);height:100vh;min-height:0;overflow:hidden}
aside{border-right:1px solid var(--line);background:var(--panel);display:flex;flex-direction:column;min-height:0;overflow-y:auto;overscroll-behavior:contain}
aside header{padding:22px 20px 16px;background:var(--paypal-blue);color:#fff;border-bottom:4px solid var(--paypal-gold)}
aside h1{margin:0 0 14px;font-size:20px;letter-spacing:-.01em}
.eyebrow{font-size:11px;letter-spacing:.12em;text-transform:uppercase;opacity:.8}.brand{display:flex;align-items:center;gap:10px}.brand-mark{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:#fff;color:var(--paypal-blue);font-weight:800;font-style:italic}
.import{display:flex;gap:8px}
.import input{flex:1;min-width:0;padding:8px 10px;border:1px solid #b9c6d8;border-radius:7px;background:#fff}
.btn{padding:8px 18px;border:0;border-radius:999px;background:#fff;color:var(--paypal-blue);cursor:pointer;font-weight:650;white-space:nowrap}
.btn:hover{background:#e8f3fb}.btn.primary{background:var(--paypal-sky);border-color:var(--paypal-sky);color:#fff}
.btn:disabled{opacity:.5;cursor:default}
#msg.meta{color:rgba(255,255,255,.88);min-height:1.5em}
#list{overflow:auto;flex:1;min-width:0;padding:10px 12px;background:var(--paper)}
.item{display:block;width:100%;padding:14px;margin:0 0 10px;border:1px solid var(--line);border-left:4px solid var(--paypal-sky);border-radius:10px;background:var(--panel);text-align:left;cursor:pointer;box-shadow:0 1px 3px rgba(20,33,61,.05)}
.item:hover,.item[aria-current=true]{background:#eef6fc;border-color:#9dc9e5;box-shadow:0 2px 7px rgba(20,33,61,.1)}
.item b{font-variant-numeric:tabular-nums;font-size:16px}
.item small{display:block;margin-top:5px;color:var(--mute);white-space:normal;overflow-wrap:anywhere}
.item-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px}
.item-label{font-size:11px;color:var(--mute);text-transform:uppercase;letter-spacing:.06em}
.chip{font-size:12px;padding:3px 8px;border-radius:99px;border:1px solid currentColor;white-space:normal;text-align:center}
.c-contest{color:var(--contest)}.c-offer_partial_refund{color:var(--refund)}.c-accept_claim{color:var(--accept)}.c-escalate_to_human{color:var(--review)}
main{padding:36px clamp(20px,5vw,56px);min-width:0;width:100%;overflow-y:auto;overscroll-behavior:contain}
.empty{color:var(--mute);max-width:46ch}
.decision{border-left:5px solid currentColor;padding-left:16px;margin:0 0 6px}
.decision h2{margin:0;font-size:26px;line-height:1.2;color:var(--ink);letter-spacing:-.015em}
.meta{color:var(--mute);margin:0 0 20px}
.src{display:inline-block;font-size:12px;color:var(--mute);border:1px solid var(--line);border-radius:4px;padding:0 6px;margin-left:8px}
.gauge{margin:24px 0}
.track{position:relative;height:14px;background:#e6ebf0;border-radius:7px;overflow:visible}
.fill{position:absolute;left:0;top:0;height:100%;border-radius:7px;background:var(--contest)}
.over{position:absolute;top:0;height:100%;background:var(--over);border-radius:0 7px 7px 0}
.tick{position:absolute;top:-5px;width:2px;height:24px;background:var(--ink)}
.gl{display:flex;justify-content:space-between;margin-top:10px;font-variant-numeric:tabular-nums}
.gl span{color:var(--mute)}
blockquote{margin:16px 0;padding:0 0 0 14px;border-left:2px solid var(--line);color:var(--mute)}
h3{font-size:15px;margin:24px 0 6px}
ul{margin:0;padding-left:20px}
textarea{width:100%;min-height:200px;padding:10px;border:1px solid var(--line);border-radius:8px;background:#fff;resize:vertical}
.row{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap}
.status{margin-top:16px;padding:10px 12px;border-radius:6px;background:#e6ebf0}
.status.bad{background:#f7e3e1;color:#7d2a25}
.trace{margin:18px 0;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:#fff;box-shadow:0 2px 8px rgba(20,33,61,.04)}
.trace ol{margin:6px 0;padding-left:22px}.trace li{margin:4px 0}.trace small{color:var(--mute)}
.ag-theme-quartz{height:100%;width:100%;--ag-font-size:13px;--ag-font-family:system-ui,-apple-system,"Segoe UI",sans-serif;--ag-foreground-color:var(--ink);--ag-secondary-foreground-color:var(--mute);--ag-header-foreground-color:var(--ink);--ag-background-color:#fff;--ag-header-background-color:#f5f7fb}
@media(max-width:760px){.app{display:block;height:auto;min-height:100vh;overflow:visible}aside{border-right:0;border-bottom:1px solid var(--line);overflow:visible}main{overflow:visible}#list{max-height:300px}}
</style></head>
<body><div class="app">
<aside><header><div class="brand"><div class="brand-mark">W</div><div><div class="eyebrow">PayPal sandbox companion</div><h1>Dispute responses</h1></div></div>
<form class="import" id="imp"><input id="impId" placeholder="PayPal dispute ID" aria-label="PayPal dispute ID"><button class="btn">Import</button></form>
<p id="msg" class="meta" role="status" style="margin:8px 0 0"></p></header>
<div id="list" class="ag-theme-quartz"></div></aside>
<main id="detail"></main></div>
<script>
var token = new URLSearchParams(location.search).get("token") || "";
var items = [], selId = null, shownState = null, gridApi = null;
var LABEL = {contest:"Contest the dispute", offer_partial_refund:"Offer a partial refund", accept_claim:"Accept the claim and refund the buyer", escalate_to_human:"Needs your review"};
var GO = {contest:"Submit evidence", offer_partial_refund:"Send offer", accept_claim:"Accept claim"};
function money(c, cur){ return (c/100).toFixed(2) + " " + cur; }
function h(tag, props){
  var e = document.createElement(tag);
  for (var k in (props||{})) { var v = props[k];
    if (k === "class") e.className = v; else if (k.slice(0,2) === "on") e.addEventListener(k.slice(2), v); else e[k] = v; }
  for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c == null) continue;
    if (Array.isArray(c)) c.forEach(function(x){ e.append(x); }); else e.append(c); }
  return e;
}
function api(path, body){
  return fetch(path, {method: body === undefined ? "GET" : "POST", headers: {"content-type":"application/json","x-admin-token":token}, body: body === undefined ? undefined : JSON.stringify(body)})
    .then(function(r){ return r.json().catch(function(){return {};}).then(function(j){ if(!r.ok) throw new Error(j.error || r.statusText); return j; }); });
}
function say(t){ document.getElementById("msg").textContent = t || ""; }
function actionOf(d){ return d.decision ? d.decision.action : "escalate_to_human"; }
function refresh(){
  return api("/api/disputes").then(function(r){
    items = r; drawList();
    var cur = items.find(function(d){ return d.id === selId; });
    if (cur && cur.workflowState !== shownState) drawDetail(cur);
    if (!cur && selId === null && items.length) select(items[0].id);
    if (!items.length) drawDetail(null);
  }).catch(function(e){ say(e.message); });
}
function drawList(){
  var list = document.getElementById("list");
  list.textContent = "";
  items.forEach(function(d){
    var a = actionOf(d), cur = d.purchase ? d.purchase.currency : "USD";
    var status = d.workflowState === "PROPOSED" ? "Needs approval" : d.workflowState.charAt(0) + d.workflowState.slice(1).toLowerCase();
    var b = h("button", {class:"item", onclick:function(){ select(d.id); }},
      h("b", null, d.amountCents != null ? money(d.amountCents, cur) : "Unknown amount"),
      h("small", null, "PayPal dispute " + (d.paypalDisputeId || d.id)),
      h("small", null, d.reason ? "Reason: " + d.reason : "Reason not provided"),
      h("div", {class:"item-meta"},
        h("span", {class:"item-label"}, "Recommended action"),
        h("span", {class:"chip c-" + a}, LABEL[a])),
      h("div", {class:"item-meta"},
        h("span", {class:"item-label"}, "Workflow"),
        h("span", {class:"item-label"}, status)));
    if (d.id === selId) b.setAttribute("aria-current", "true");
    list.append(b);
  });
}
function select(id){ selId = id; drawList(); drawDetail(items.find(function(d){ return d.id === id; })); }
function gauge(d){
  var p = d.purchase, m = d.mandate; if (!p || !m) return null;
  var top = Math.max(p.amountCents, m.maxAmountCents), pct = function(c){ return (c / top * 100) + "%"; };
  var track = h("div", {class:"track"});
  var fill = h("div", {class:"fill"}); fill.style.width = pct(Math.min(p.amountCents, m.maxAmountCents)); track.append(fill);
  if (p.amountCents > m.maxAmountCents) { var o = h("div", {class:"over"}); o.style.left = pct(m.maxAmountCents); o.style.width = pct(p.amountCents - m.maxAmountCents); track.append(o); }
  var t = h("div", {class:"tick"}); t.style.left = pct(m.maxAmountCents); track.append(t);
  return h("div", {class:"gauge", role:"img", "aria-label":"Purchase " + money(p.amountCents, p.currency) + " against a mandate limit of " + money(m.maxAmountCents, m.currency)},
    track, h("div", {class:"gl"}, h("span", null, "Purchase " + money(p.amountCents, p.currency)), h("span", null, "Mandate limit " + money(m.maxAmountCents, m.currency))));
}
function act(path, body, btns){
  btns.forEach(function(b){ b.disabled = true; }); say("");
  api(path, body).then(function(){ return refresh(); }).then(function(){ drawDetail(items.find(function(d){ return d.id === selId; })); })
    .catch(function(e){ say(e.message); btns.forEach(function(b){ b.disabled = false; }); });
}
function drawDetail(d){
  var el = document.getElementById("detail"); el.textContent = "";
  if (!d) { shownState = null; el.append(h("p", {class:"empty"}, "No disputes yet. When a buyer disputes a payment, Warrant's proposed response appears here for your approval. You can also import a dispute by its PayPal ID.")); return; }
  shownState = d.workflowState;
  var a = actionOf(d), dec = d.decision || {};
  var title = LABEL[a] + (a === "offer_partial_refund" && dec.refundCents ? ": " + money(dec.refundCents, d.purchase ? d.purchase.currency : "USD") : "");
  el.append(h("div", {class:"decision c-" + a}, h("h2", null, title)));
  el.append(h("p", {class:"meta"}, "Dispute " + d.paypalDisputeId + (d.reason ? ", reason " + d.reason : ""),
    d.narrativeSource ? h("span", {class:"src", title: d.narrativeFallbackReason || ""}, d.narrativeSource === "llm" ? "Explained by AI" : "Template text") : null));
  el.append(h("p", null, d.explanation || dec.reason || ""));
  var g = gauge(d); if (g) el.append(g);
  if (d.mandate) el.append(h("blockquote", null, "The user told their agent: " + d.mandate.description));
  if (d.signatureValid !== undefined && d.mandate) el.append(h("p", null, d.signatureValid ? "The mandate signature is valid." : "The mandate signature could not be verified."));
  if (d.mandate) { el.append(h("h3", null, "Checks against the mandate"));
    el.append((d.findings && d.findings.length) ? h("ul", null, d.findings.map(function(f){ return h("li", null, f.message); })) : h("p", null, "The purchase is within the mandate.")); }
  if (d.agentEvents && d.agentEvents.length) {
    var trace = h("section", {class:"trace"}, h("strong", null, "Merchant agent activity"));
    var steps = h("ol");
    d.agentEvents.forEach(function(ev){ steps.append(h("li", null, h("b", null, ev.toolName.replace(/_/g, " ")), " ", h("small", null, ev.eventType))); });
    trace.append(steps); el.append(trace);
  }
  var open = d.workflowState === "PROPOSED" || d.workflowState === "FAILED";
  if (d.workflowState === "FAILED") el.append(h("p", {class:"status bad"}, "PayPal did not accept the submission: " + (d.submitError || "unknown error") + " You can edit the note and try again."));
  if (d.workflowState === "SUBMITTED") el.append(h("p", {class:"status"}, "Submitted to PayPal."));
  if (d.workflowState === "REJECTED") el.append(h("p", {class:"status"}, "You dismissed this proposal. Nothing was sent to PayPal."));
  if (open && a !== "escalate_to_human" && !d.blockedReason) {
    el.append(h("h3", null, "Note sent to PayPal (you can edit it)"));
    var ta = h("textarea", {value: d.evidenceNote || "", maxLength: 2000}); el.append(ta);
    var go = h("button", {class:"btn primary"}, d.workflowState === "FAILED" ? "Try again" : GO[a]);
    var no = h("button", {class:"btn"}, "Dismiss");
    go.addEventListener("click", function(){ act("/api/disputes/" + d.id + "/approve", {note: ta.value}, [go, no]); });
    no.addEventListener("click", function(){ act("/api/disputes/" + d.id + "/reject", {}, [go, no]); });
    el.append(h("div", {class:"row"}, go, no));
  } else if (open) {
    var dis = h("button", {class:"btn"}, "Dismiss");
    dis.addEventListener("click", function(){ act("/api/disputes/" + d.id + "/reject", {}, [dis]); });
    el.append(h("p", {class:"status"}, d.blockedReason || "Warrant can't submit this one. Handle it in your PayPal dispute dashboard."), h("div", {class:"row"}, dis));
  }
}
document.getElementById("imp").addEventListener("submit", function(ev){
  ev.preventDefault(); var inp = document.getElementById("impId"), id = inp.value.trim(); if (!id) return;
  say("Importing...");
  api("/api/disputes/import", {paypalDisputeId: id}).then(function(r){ inp.value = ""; say(""); selId = r.id; return refresh(); }).then(function(){ select(selId); })
    .catch(function(e){ say(e.message); });
});
refresh(); setInterval(refresh, 10000);
</script></body></html>`;