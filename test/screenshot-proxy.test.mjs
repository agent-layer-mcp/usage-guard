import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startScreenshotMemoryProxy } from "../src/screenshot-proxy.mjs";

test("proxy replaces expired images and streams the upstream response", async (t) => {
  const received = [];
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push(JSON.parse(body));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
  });
  await listen(upstream);
  t.after(() => upstream.close());
  const root = mkdtempSync(path.join(os.tmpdir(), "usage-guard-screenshot-proxy-"));
  const statusPath = path.join(root, "status.json");
  const proxy = await startScreenshotMemoryProxy({
    port: 0,
    upstream: address(upstream),
    retentionTurns: 2,
    statusPath,
  });
  t.after(() => proxy.server.close());

  const imageData = Buffer.from("image-payload").toString("base64");
  const response = await fetch(`${proxy.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Screenshot of a red error banner." },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: imageData },
            },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "The error says invalid tag." }] },
        { role: "user", content: [{ type: "text", text: "First follow-up" }] },
        { role: "assistant", content: [{ type: "text", text: "First reply" }] },
        { role: "user", content: [{ type: "text", text: "Second follow-up" }] },
      ],
    }),
  });

  assert.equal(response.status, 200);
  assert.match(await response.text(), /message_stop/);
  assert.equal(received.length, 1);
  assert.equal(received[0].messages[0].content[1].type, "text");
  assert.doesNotMatch(JSON.stringify(received[0]), new RegExp(imageData));
  const stats = JSON.parse(readFileSync(statusPath, "utf8"));
  assert.equal(stats.requestsTransformed, 1);
  assert.equal(stats.imagesReplaced, 1);
  assert.equal(stats.imageBytesReplaced, Buffer.byteLength("image-payload"));
});

test("proxy health endpoint does not contact upstream", async (t) => {
  const upstream = http.createServer((_request, response) => response.end("unexpected"));
  await listen(upstream);
  t.after(() => upstream.close());
  const proxy = await startScreenshotMemoryProxy({
    port: 0,
    upstream: address(upstream),
    statusPath: path.join(os.tmpdir(), `usage-guard-${process.pid}-health.json`),
  });
  t.after(() => proxy.server.close());
  const response = await fetch(`${proxy.url}/health`);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.retentionTurns, 5);
});

test("proxy leaves malformed JSON for the upstream to validate", async (t) => {
  let receivedBody = null;
  const upstream = http.createServer(async (request, response) => {
    receivedBody = await readBody(request);
    response.writeHead(400, { "content-type": "application/json" });
    response.end('{"error":"invalid_json"}');
  });
  await listen(upstream);
  t.after(() => upstream.close());
  const proxy = await startScreenshotMemoryProxy({
    port: 0,
    upstream: address(upstream),
    statusPath: path.join(mkdtempSync(path.join(os.tmpdir(), "usage-guard-proxy-")), "status.json"),
  });
  t.after(() => proxy.server.close());

  const response = await fetch(`${proxy.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not-json",
  });

  assert.equal(response.status, 400);
  assert.equal(receivedBody, "{not-json");
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function address(server) {
  const value = server.address();
  return `http://127.0.0.1:${value.port}`;
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}
