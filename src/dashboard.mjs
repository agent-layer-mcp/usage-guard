import http from "node:http";
import { completeStatus, syncCodex } from "./service.mjs";

export function startDashboard(store, options = {}) {
  const host = options.host || "127.0.0.1";
  const port = Number(options.port || store.getConfig().dashboardPort);
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);
      if (request.method === "GET" && url.pathname === "/") return html(response, dashboardHtml());
      if (request.method === "GET" && url.pathname === "/api/status") return json(response, 200, completeStatus(store));
      if (request.method === "POST" && url.pathname === "/api/sync/codex") {
        await syncCodex(store);
        return json(response, 200, completeStatus(store));
      }
      if (request.method === "PATCH" && url.pathname === "/api/config") {
        const body = await readJson(request);
        const config = store.setConfig(body);
        return json(response, 200, config);
      }
      return json(response, 404, { error: "Not found" });
    } catch (error) {
      return json(response, 500, { error: error.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve({ server, url: `http://${host}:${port}` }));
  });
}

function json(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function html(response, value) {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
  });
  response.end(value);
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 64_000) throw new Error("Request body is too large.");
  }
  return body ? JSON.parse(body) : {};
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Usage Guard</title>
  <style>
    :root{color-scheme:light;--paper:#f4f1ea;--tint:#ede8de;--card:#fff;--ink:#26221d;--muted:#6f6a62;--faint:#a39d93;--line:rgba(38,34,29,.14);--seal:#c2452d;--good:#5f8f6b;--warn:#b07a45;--mono:ui-monospace,"SFMono-Regular",Menlo,monospace}
    .overnight{margin:0 0 22px;padding:12px 16px;background:var(--tint);color:var(--muted);font:12px/1.5 var(--mono)}.overnight:empty{display:none}.models{margin-top:16px;border-top:1px solid var(--line);padding-top:14px;font:12px/1.6 var(--mono)}.models div{display:flex;justify-content:space-between;gap:16px}.models span{color:var(--muted)}.models strong{font-weight:600;text-align:right}.models p{margin:8px 0 0;color:var(--muted);font:12px/1.5 system-ui,-apple-system,sans-serif}
    *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 system-ui,-apple-system,sans-serif}button{font:inherit}header{height:64px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 28px;position:sticky;top:0;background:rgba(244,241,234,.94);backdrop-filter:blur(12px)}.brand{font:700 16px var(--mono)}.brand b{color:var(--seal)}.local{font:11px var(--mono);color:var(--muted);text-transform:uppercase;letter-spacing:.12em}.shell{max-width:1160px;margin:0 auto;padding:38px 28px 64px}.top{display:flex;justify-content:space-between;gap:28px;align-items:end;margin-bottom:28px}.eyebrow{font:11px var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--faint)}h1{font-size:38px;line-height:1.05;letter-spacing:0;margin:8px 0 0;max-width:720px}.sub{color:var(--muted);max-width:570px;margin:10px 0 0}.sync{border:1px solid var(--line);background:var(--card);border-radius:8px;padding:10px 14px;cursor:pointer;color:var(--ink)}.sync:hover{border-color:rgba(38,34,29,.35)}.providers{display:grid;grid-template-columns:1fr 1fr;border:1px solid var(--line);background:var(--card)}.provider{padding:24px}.provider+ .provider{border-left:1px solid var(--line)}.provider-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:22px}.provider-name{font-weight:700;font-size:18px}.state{font:700 10px var(--mono);letter-spacing:.14em;text-transform:uppercase;border:1px solid currentColor;border-radius:5px;padding:5px 8px;transform:rotate(-2deg)}.state.safe{color:var(--good)}.state.watch,.state.stale{color:var(--warn)}.state.protect,.state.queue{color:var(--seal)}.state.missing{color:var(--faint)}.window{display:grid;grid-template-columns:130px 1fr 54px;gap:16px;align-items:center;padding:14px 0;border-top:1px solid var(--line)}.window-label,.percent{font:12px var(--mono)}.percent{text-align:right;font-variant-numeric:tabular-nums}.track{height:9px;background:var(--tint);display:grid;grid-template-columns:repeat(20,1fr);gap:2px;padding:2px}.tick{background:transparent}.tick.on{background:var(--ink)}.tick.reserve{background:var(--seal)}.context{margin-top:14px;padding:10px 12px;border:1px solid var(--line);font:11px var(--mono);display:flex;justify-content:space-between;gap:12px}.context strong{color:var(--seal)}.choice{margin-top:20px;background:var(--tint);padding:16px;border-left:3px solid var(--ink)}.choice-label{font:10px var(--mono);color:var(--faint);letter-spacing:.13em;text-transform:uppercase}.choice strong{display:block;margin:4px 0}.choice p{margin:0;color:var(--muted);font-size:13px}.ledger{margin-top:28px;border-top:1px solid var(--line)}.ledger h2{font-size:20px;margin:28px 0 14px}.row{display:grid;grid-template-columns:82px 90px 170px 1fr;gap:14px;padding:12px 0;border-bottom:1px solid var(--line);font:11px/1.5 var(--mono)}.row span:first-child,.row span:nth-child(2){color:var(--faint)}.privacy{margin-top:28px;display:flex;gap:18px;flex-wrap:wrap;font:11px var(--mono);color:var(--muted)}.privacy span:before{content:"";display:inline-block;width:7px;height:7px;background:var(--good);margin-right:7px}@media(max-width:760px){header{padding:0 18px}.shell{padding:28px 18px}.top{display:block}.sync{margin-top:20px}.providers{grid-template-columns:1fr}.provider+ .provider{border-left:0;border-top:1px solid var(--line)}.window{grid-template-columns:90px 1fr 48px}.row{grid-template-columns:72px 1fr}.row span:nth-child(3),.row span:nth-child(4){grid-column:2}}
  </style>
</head>
<body>
  <header><div class="brand">usage guard<b>.</b></div><div class="local">Local only</div></header>
  <main class="shell">
    <div class="top"><div><div class="eyebrow">Live quota ledger</div><h1>Protect the session. Use the right model.</h1><p class="sub">Five-hour and weekly pacing for Claude Code and Codex, with each model recommendation visible.</p></div><button class="sync" id="sync">Sync Codex</button></div>
    <p class="overnight" id="overnight"></p>
    <section class="providers" id="providers" aria-live="polite"></section>
    <section class="ledger"><h2>Decision ledger</h2><div id="ledger"></div></section>
    <div class="privacy"><span>No prompt storage</span><span>No source-code storage</span><span>No credential access</span><span>No telemetry</span></div>
  </main>
  <script>
    const providers=document.querySelector('#providers'),ledger=document.querySelector('#ledger'),sync=document.querySelector('#sync'),overnight=document.querySelector('#overnight');
    const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    function ticks(w){const used=Math.round(w.usedPercent/5),reserve=Math.round((100-w.reservePercent)/5);return '<div class="track">'+Array.from({length:20},(_,i)=>'<i class="tick '+(i<used?'on ':'')+(i>=reserve?'reserve':'')+'"></i>').join('')+'</div>'}
    function modelHtml(p){if(!p.modelStepping)return '';const model=(name,effort)=>name?esc(name)+' ('+esc(effort||'default')+')':'waiting for fresh quota';return '<div class="models"><div><span>Main thread</span><strong>'+model(p.recommendedModel,p.recommendedEffort)+'</strong></div><div><span>Routine subagents</span><strong>'+model(p.routineModel,p.routineEffort)+'</strong></div><p>'+esc(p.modelReason)+'</p></div>'}
    function render(data){overnight.textContent=data.overnightSummary||'';providers.innerHTML=data.providers.map(p=>'<article class="provider"><div class="provider-head"><div class="provider-name">'+(p.provider==='claude'?'Claude Code':'Codex')+'</div><div class="state '+esc(p.state)+'">'+esc(p.state)+'</div></div>'+(p.windows.length?p.windows.map(w=>'<div class="window"><div class="window-label">'+esc(w.label)+'</div>'+ticks(w)+'<div class="percent">'+Math.round(w.usedPercent)+'%</div></div>').join(''):'<div class="window"><div class="window-label">Waiting</div><div class="track"></div><div class="percent">--</div></div>')+(p.context?'<div class="context"><span>Session context</span><strong>'+Math.round(p.context.contextPercent)+'% · '+esc(p.contextState)+'</strong></div>':'')+'<div class="choice"><div class="choice-label">Deliberate choice</div><strong>'+esc(p.action)+'</strong><p>'+esc(p.reason)+'</p></div>'+modelHtml(p)+'</article>').join('');ledger.innerHTML=data.recentDecisions.length?data.recentDecisions.map(d=>'<div class="row"><span>'+new Date(d.createdAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})+'</span><span>'+esc(d.provider)+'</span><span>'+esc(d.action)+'</span><span>'+esc(d.reason)+'</span></div>').join(''):'<div class="row"><span>now</span><span>guard</span><span>waiting for first decision</span><span>Quota events will appear here.</span></div>'}
    async function load(){const r=await fetch('/api/status');render(await r.json())}sync.onclick=async()=>{sync.disabled=true;sync.textContent='Syncing';try{const r=await fetch('/api/sync/codex',{method:'POST'});render(await r.json())}finally{sync.disabled=false;sync.textContent='Sync Codex'}};load();setInterval(load,15000);
  </script>
</body>
</html>`;
}
