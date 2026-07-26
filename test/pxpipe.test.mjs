import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readPxpipeTelemetry,
  weightedInputEquivalent,
} from "../src/providers/pxpipe.mjs";

test("pxpipe telemetry reports local request cost drivers without prompt content", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "usage-guard-pxpipe-"));
  const filename = path.join(root, "events.jsonl");
  const now = Date.UTC(2026, 6, 26, 10, 10);
  writeFileSync(filename, [
    JSON.stringify({ ts: new Date(now - 60_000).toISOString(), method: "HEAD", path: "/", status: 404 }),
    JSON.stringify({
      ts: new Date(now - 30_000).toISOString(),
      method: "POST",
      path: "/v1/messages",
      status: 200,
      model: "claude-opus-5",
      baseline_tokens: 566_691,
      image_count: 143,
      input_tokens: 10,
      output_tokens: 100,
      cache_create_tokens: 1_000,
      cache_read_tokens: 500_000,
      prompt: "must not be returned",
    }),
  ].join("\n"));

  const telemetry = readPxpipeTelemetry({
    filename,
    now,
    env: { DISABLE_MICROCOMPACT: "1" },
  });

  assert.equal(telemetry.contextTokens, 566_691);
  assert.equal(telemetry.imageCount, 143);
  assert.equal(telemetry.weightedInputEquivalent, 51_760);
  assert.equal(telemetry.microcompactDisabled, true);
  assert.equal("prompt" in telemetry, false);
  assert.equal(telemetry.stale, false);
});

test("pxpipe telemetry is optional and marks old evidence stale", () => {
  assert.equal(readPxpipeTelemetry({ filename: "/tmp/does-not-exist" }), null);

  const root = mkdtempSync(path.join(os.tmpdir(), "usage-guard-pxpipe-stale-"));
  const filename = path.join(root, "events.jsonl");
  const observedAt = Date.UTC(2026, 6, 26, 8);
  writeFileSync(filename, `${JSON.stringify({
    ts: new Date(observedAt).toISOString(),
    method: "POST",
    path: "/v1/messages",
    status: 200,
    baseline_tokens: 100,
  })}\n`);
  assert.equal(readPxpipeTelemetry({
    filename,
    now: observedAt + 16 * 60_000,
  }).stale, true);
});

test("weighted request cost uses documented directional API ratios", () => {
  assert.equal(weightedInputEquivalent({
    input_tokens: 1,
    cache_create_tokens: 8,
    cache_read_tokens: 10,
    output_tokens: 2,
  }), 22);
});
