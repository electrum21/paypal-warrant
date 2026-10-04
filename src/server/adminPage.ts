// Single self-contained page. All dynamic text goes through textContent (mandate descriptions are
// written by a third party, so nothing from the API is ever inserted as HTML).
export const adminPageHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Warrant: dispute responses</title>
<style>
:root{--ink:#17202b;--mute:#5b6674;--paper:#f3f5f7;--panel:#fff;--line:#d3dae1;
--contest:#0f6e6e;--refund:#a86414;--accept:#a63a3a;--review:#55606e;--over:#c2453d}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
button,input,textarea{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--contest);outline-offset:2px}
.app{display:grid;grid-template-columns:340px 1fr;min-height:100vh}
aside{border-right:1px solid var(--line);background:var(--panel);display:flex;flex-direction:column}
aside header{padding:20px 20px 12px}
aside h1{margin:0 0 12px;font-size:20px;letter-spacing:-.01em}
.import{display:flex;gap:8px}
.import input{flex:1;min-width:0;padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:#fff}
.btn{padding:7px 14px;border:1px solid var(--line);border-radius:6px;background:#fff;cursor:pointer}
.btn:hover{border-color:var(--ink)}
.btn.primary{background:var(--ink);border-color:var(--ink);color:#fff}
.btn:disabled{opacity:.5;cursor:default}
#list{overflow:auto;flex:1}
.item{display:flex;justify-content:space-between;gap:12px;width:100%;padding:12px 20px;border:0;border-top:1px solid var(--line);background:none;text-align:left;cursor:pointer}
.item:hover,.item[aria-current=true]{background:var(--paper)}
.item b{font-variant-numeric:tabular-nums}
.item small{display:block;color:var(--mute)}
.chip{align-self:center;font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid currentColor;white-space:nowrap}
.c-contest{color:var(--contest)}.c-offer_partial_refund{color:var(--refund)}.c-accept_claim{color:var(--accept)}.c-escalate_to_human{color:var(--review)}
main{padding:32px clamp(20px,5vw,56px);max-width:820px}
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
textarea{width:100%;min-height:200px;padding:10px;border:1px solid var(--line);border-radius:6px;background:#fff;resize:vertical}
.row{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap}
.status{margin-top:16px;padding:10px 12px;border-radius:6px;background:#e6ebf0}
.status.bad{background:#f7e3e1;color:#7d2a25}
.trace{margin:18px 0;padding:12px 14px;border:1px solid var(--line);border-radius:8px;background:#fbfcfd}
.trace ol{margin:6px 0 0;padding-left:22px}.trace li{margin:4px 0}.trace small{color:var(--mute)}
@media(max-width:760px){.app{grid-template-columns:1fr}aside{border-right:0;border-bottom:1px solid var(--line)}#list{max-height:240px}}
</style></head>
<body><div class="app">
<aside><header><h1>Dispute responses</h1>
<form class="import" id="imp"><input id="impId" placeholder="PayPal dispute ID" aria-label="PayPal dispute ID"><button class="btn">Import</button></form>
<p id="msg" class="meta" role="status" style="margin:8px 0 0"></p></header>
<div id="list"></div></aside>
<main id="detail"></main></div>
<script>
var token = new URLSearchParams(location.search).get("token") || "";
var items = [], selId = null, shownState = null;
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
  var list = document.getElementById("list"); list.textContent = "";
  items.forEach(function(d){
    var a = actionOf(d), cur = d.purchase ? d.purchase.currency : "";
    var b = h("button", {class:"item", onclick:function(){ select(d.id); }},
      h("span", null, h("b", null, d.amountCents != null ? money(d.amountCents, cur || "USD") : "Unknown amount"), h("small", null, d.reason || "")),
      h("span", {class:"chip c-" + a}, d.workflowState === "PROPOSED" ? "Needs approval" : d.workflowState.charAt(0) + d.workflowState.slice(1).toLowerCase()));
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