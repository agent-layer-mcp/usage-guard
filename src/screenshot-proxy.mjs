import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { guardHome } from "./config.mjs";
import {
  isScreenshotMemoryRequest,
  transformScreenshotMemory,
} from "./screenshot-memory.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 47_822;
const DEFAULT_UPSTREAM = "http://127.0.0.1:47821";
const DEFAULT_MAX_BODY_BYTES = 64 * 1_024 * 1_024;

export async function startScreenshotMemoryProxy(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const requestedPort = options.port === 0 ? 0 : finitePort(options.port, DEFAULT_PORT);
  const upstream = normalizeUpstream(options.upstream || DEFAULT_UPSTREAM);
  const retentionTurns = positiveInteger(options.retentionTurns, 5);
  const statusPath = options.statusPath
    || path.join(guardHome(options.env), "screenshot-memory-status.json");
  const stats = readStats(statusPath, { retentionTurns, upstream });
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        return sendJson(response, 200, {
          ok: true,
          service: "usage-guard-screenshot-memory",
          retentionTurns,
          upstream,
        });
      }
      if (request.method === "GET" && request.url === "/stats") {
        return sendJson(response, 200, stats);
      }
      await forwardRequest(request, response, {
        upstream,
        retentionTurns,
        maxBodyBytes: options.maxBodyBytes || DEFAULT_MAX_BODY_BYTES,
        onTransform(info) {
          updateStats(stats, info);
          writeStats(statusPath, stats);
          options.onTransform?.(info);
        },
      });
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, error.statusCode || 502, {
          error: "screenshot_memory_proxy_error",
          message: error.message,
        });
      } else {
        response.destroy(error);
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : requestedPort;
  return {
    server,
    host,
    port,
    upstream,
    retentionTurns,
    url: `http://${host}:${port}`,
    statusPath,
  };
}

export function readScreenshotMemoryStatus(options = {}) {
  const filename = options.filename
    || path.join(guardHome(options.env), "screenshot-memory-status.json");
  try {
    const parsed = JSON.parse(readFileSync(filename, "utf8"));
    return sanitizeStats(parsed);
  } catch {
    return null;
  }
}

async function forwardRequest(request, response, options) {
  const requestUrl = new URL(request.url || "/", options.upstream);
  let body = await readBody(request, options.maxBodyBytes);
  let transformInfo = null;
  if (
    body.length
    && isScreenshotMemoryRequest(requestUrl.pathname, request.method)
    && isJsonRequest(request.headers)
  ) {
    try {
      const parsed = JSON.parse(body.toString("utf8"));
      const transformed = transformScreenshotMemory(parsed, {
        retentionTurns: options.retentionTurns,
      });
      transformInfo = transformed.info;
      if (transformed.applied) {
        body = Buffer.from(JSON.stringify(transformed.body));
      }
    } catch {
      // Preserve the upstream's own validation behavior for malformed payloads.
    }
  }

  const headers = forwardHeaders(request.headers, body.length);
  const upstreamResponse = await fetch(requestUrl, {
    method: request.method,
    headers,
    body: body.length ? body : undefined,
    redirect: "manual",
  });
  const responseHeaders = {};
  for (const [key, value] of upstreamResponse.headers.entries()) {
    if (
      !isHopByHopHeader(key)
      && key.toLowerCase() !== "content-length"
      && key.toLowerCase() !== "content-encoding"
    ) {
      responseHeaders[key] = value;
    }
  }
  response.writeHead(upstreamResponse.status, responseHeaders);
  if (upstreamResponse.body) {
    Readable.fromWeb(upstreamResponse.body).pipe(response);
  } else {
    response.end();
  }
  if (transformInfo) options.onTransform(transformInfo);
}

async function readBody(request, maxBytes) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBytes) {
      const error = new Error(`Request body exceeds ${maxBytes} bytes.`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function forwardHeaders(input, bodyLength) {
  const output = new Headers();
  for (const [key, value] of Object.entries(input)) {
    if (value == null || isHopByHopHeader(key) || key.toLowerCase() === "host") continue;
    if (Array.isArray(value)) {
      for (const item of value) output.append(key, item);
    } else {
      output.set(key, value);
    }
  }
  output.set("accept-encoding", "identity");
  output.set("content-length", String(bodyLength));
  return output;
}

function isHopByHopHeader(key) {
  return [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ].includes(String(key).toLowerCase());
}

function isJsonRequest(headers) {
  return String(headers["content-type"] || "").toLowerCase().includes("application/json");
}

function updateStats(stats, info) {
  stats.updatedAt = Date.now();
  stats.requestsObserved += 1;
  if (info.imagesReplaced > 0) stats.requestsTransformed += 1;
  stats.imagesReplaced += info.imagesReplaced;
  stats.imageBytesReplaced += info.imageBytesReplaced;
  stats.lastRequestImagesReplaced = info.imagesReplaced;
  stats.lastRequestBytesReplaced = info.imageBytesReplaced;
}

function readStats(filename, defaults) {
  try {
    return {
      ...baseStats(defaults),
      ...sanitizeStats(JSON.parse(readFileSync(filename, "utf8"))),
      retentionTurns: defaults.retentionTurns,
      upstream: defaults.upstream,
    };
  } catch {
    return baseStats(defaults);
  }
}

function baseStats({ retentionTurns, upstream }) {
  return {
    version: 1,
    updatedAt: null,
    retentionTurns,
    upstream,
    requestsTransformed: 0,
    requestsObserved: 0,
    imagesReplaced: 0,
    imageBytesReplaced: 0,
    lastRequestImagesReplaced: 0,
    lastRequestBytesReplaced: 0,
  };
}

function sanitizeStats(value) {
  if (!value || typeof value !== "object") return null;
  return {
    version: 1,
    updatedAt: finiteOrNull(value.updatedAt),
    retentionTurns: positiveInteger(value.retentionTurns, 5),
    upstream: typeof value.upstream === "string" ? value.upstream : null,
    requestsTransformed: nonNegativeInteger(value.requestsTransformed),
    requestsObserved: nonNegativeInteger(value.requestsObserved),
    imagesReplaced: nonNegativeInteger(value.imagesReplaced),
    imageBytesReplaced: nonNegativeInteger(value.imageBytesReplaced),
    lastRequestImagesReplaced: nonNegativeInteger(value.lastRequestImagesReplaced),
    lastRequestBytesReplaced: nonNegativeInteger(value.lastRequestBytesReplaced),
  };
}

function writeStats(filename, stats) {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(stats, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, filename);
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

function normalizeUpstream(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Screenshot Memory upstream must use http or https.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Screenshot Memory upstream must not contain credentials, query parameters, or fragments.");
  }
  return url.toString().replace(/\/$/, "");
}

function finitePort(value, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1_024 || number > 65_535) return fallback;
  return number;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.round(number);
}

function nonNegativeInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.round(number);
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
