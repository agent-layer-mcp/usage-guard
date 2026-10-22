import fs from "node:fs";
import http from "node:http";
import { listOpenRouterModels } from "./openrouter-models.mjs";
import { readOpenRouterSpend, routeJob } from "./route.mjs";
import { completeStatus, syncCodex } from "./service.mjs";
import { shellHtml } from "./ui/panel.js";

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

export function startDashboard(store, options = {}) {
  const host = options.host || "127.0.0.1";
  let spend = { at: 0, value: null };
  // Tray polls every 30s; read OpenRouter spend at most every 5 minutes.
  const readSpend = async () => {
    if (!spend.value || Date.now() - spend.at > 5 * 60_000) {
      spend = { at: Date.now(), value: await (options.readSpend || readOpenRouterSpend)() };
    }
    return spend.value;
  };
  const port = Number(options.port || store.getConfig().dashboardPort);
  const server = http.createServer(async (request, response) => {
    try {
      // DNS rebinding: only answer requests addressed to this machine by a loopback name.
      if (!LOOPBACK_HOST.test(request.headers.host || "")) return json(response, 403, { error: "Forbidden host" });
      // CSRF: a browser marks cross-site requests with Origin; changes must come from this page (the tray sends none).
      const origin = request.headers.origin;
      if (request.method !== "GET" && origin && !LOOPBACK_ORIGIN.test(origin)) return json(response, 403, { error: "Forbidden origin" });
      const url = new URL(request.url || "/", `http://${request.headers.host}`);
      if (request.method === "GET" && url.pathname === "/") return html(response, dashboardHtml());
      if (request.method === "GET" && url.pathname.startsWith("/ui/") && Object.hasOwn(UI_FILES, url.pathname.slice(4))) return asset(response, url.pathname.slice(4));
      if (request.method === "GET" && url.pathname === "/api/status") return json(response, 200, completeStatus(store));
      if (request.method === "GET" && url.pathname === "/api/route") {
        // Previews for the tray are not logged; `usage-guard route` records real routing.
        return json(response, 200, routeJob(store, url.searchParams.get("kind") || "code", {
          record: false,
          payAsYouGo: await readSpend(),
        }));
      }
      if (request.method === "GET" && url.pathname === "/api/models") {
        return json(response, 200, await (options.listModels || listOpenRouterModels)({ refresh: url.searchParams.has("refresh") }));
      }
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
      return json(response, error instanceof TypeError ? 400 : 500, { error: error.message });
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

// The panel's shared files (also copied into tray/ui/), served from an allowlist so nothing else under src/ is reachable.
const UI_FILES = {
  "style.css": "text/css; charset=utf-8",
  "format.js": "text/javascript; charset=utf-8",
  "tabs.js": "text/javascript; charset=utf-8",
  "render.js": "text/javascript; charset=utf-8",
  "panel.js": "text/javascript; charset=utf-8",
  "agent-layer-mark.svg": "image/svg+xml",
  "fonts/Inter-latin.woff2": "font/woff2",
};

function asset(response, name) {
  response.writeHead(200, { "Content-Type": UI_FILES[name], "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(fs.readFileSync(new URL(`./ui/${name}`, import.meta.url)));
}

function html(response, value) {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "X-Frame-Options": "DENY",
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

export function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Usage Guard</title>
  <link rel="stylesheet" href="/ui/style.css">
</head>
<body>
  <div class="page">
    <header class="top-bar">
      <div class="brand">
        <img class="brand-mark" src="/ui/agent-layer-mark.svg" alt="" aria-hidden="true">
        <span class="brand-wordmark">agent layer</span>
        <span class="brand-product">usage guard</span>
      </div>
      <div class="top-actions"><span class="eyebrow">local only</span><button type="button" class="btn btn-secondary" id="sync">Sync Codex</button></div>
    </header>
    <main id="app">${shellHtml()}</main>
  </div>
  <script type="module">
    import { mountPanel } from "/ui/panel.js";
    const CODEX_USAGE_URL = "https://chatgpt.com/codex/settings/usage";
    const send = async (url, init) => {
      const response = await fetch(url, init);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || response.statusText);
      return body;
    };
    const panel = mountPanel({
      wide: true,
      decisionLimit: 50,
      storage: (() => { try { return window.localStorage; } catch { return null; } })(),
      api: {
        status: () => send("/api/status"),
        route: () => send("/api/route?kind=code"),
        models: (refresh) => send(refresh ? "/api/models?refresh" : "/api/models"),
        setConfig: (patch) => send("/api/config", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }),
        openCodexUsage: () => window.open(CODEX_USAGE_URL, "_blank", "noopener"),
      },
    });
    const sync = document.getElementById("sync");
    sync.onclick = async () => {
      sync.disabled = true;
      sync.textContent = "Syncing";
      try { await send("/api/sync/codex", { method: "POST" }); await panel.refresh(); } finally { sync.disabled = false; sync.textContent = "Sync Codex"; }
    };
  </script>
</body>
</html>`;
}
