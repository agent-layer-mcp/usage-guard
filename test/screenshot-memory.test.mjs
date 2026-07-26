import test from "node:test";
import assert from "node:assert/strict";
import { transformScreenshotMemory } from "../src/screenshot-memory.mjs";

const IMAGE_DATA = Buffer.from("pretend-png-bytes").toString("base64");

test("keeps screenshots inside the five-user-turn live tail", () => {
  const body = requestWithImageAndLaterTurns(4);
  const result = transformScreenshotMemory(body, { retentionTurns: 5 });
  assert.equal(result.applied, false);
  assert.equal(result.body.messages[0].content[1].type, "image");
});

test("replaces screenshots once five later user turns exist", () => {
  const body = requestWithImageAndLaterTurns(5);
  const result = transformScreenshotMemory(body, { retentionTurns: 5 });
  const replacement = result.body.messages[0].content[1];
  assert.equal(result.applied, true);
  assert.equal(result.info.imagesReplaced, 1);
  assert.equal(result.info.imageBytesReplaced, Buffer.byteLength("pretend-png-bytes"));
  assert.equal(replacement.type, "text");
  assert.match(replacement.text, /Original user context: This button overlaps the navigation/);
  assert.match(replacement.text, /Assistant interpretation.*bottom navigation overlaps/);
  assert.match(replacement.text, /sha256:/);
  assert.doesNotMatch(JSON.stringify(result.body), new RegExp(IMAGE_DATA));
});

test("uses user context without inventing a visual description", () => {
  const body = requestWithImageAndLaterTurns(5);
  body.messages.splice(1, 1);
  const result = transformScreenshotMemory(body, { retentionTurns: 5 });
  const replacement = result.body.messages[0].content[1].text;
  assert.match(replacement, /No assistant interpretation was available/);
  assert.match(replacement, /contextual memory, not a byte-exact transcription/);
});

test("pin marker keeps an old screenshot visual", () => {
  const body = requestWithImageAndLaterTurns(8);
  body.messages[0].content[0].text += " [usage-guard:pin-images]";
  const result = transformScreenshotMemory(body, { retentionTurns: 5 });
  assert.equal(result.applied, false);
  assert.equal(result.body.messages[0].content[1].type, "image");
});

test("does not mutate the caller's request", () => {
  const body = requestWithImageAndLaterTurns(5);
  transformScreenshotMemory(body, { retentionTurns: 5 });
  assert.equal(body.messages[0].content[1].type, "image");
  assert.equal(body.messages[0].content[1].source.data, IMAGE_DATA);
});

test("leaves non-Anthropic and malformed bodies unchanged", () => {
  const malformed = { messages: "not-an-array" };
  const result = transformScreenshotMemory(malformed);
  assert.equal(result.applied, false);
  assert.equal(result.body, malformed);
});

function requestWithImageAndLaterTurns(laterTurns) {
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "This button overlaps the navigation." },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: IMAGE_DATA,
          },
        },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "The screenshot shows that the bottom navigation overlaps the primary action.",
        },
      ],
    },
  ];
  for (let index = 0; index < laterTurns; index += 1) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: `Follow-up ${index + 1}` }],
    });
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: `Reply ${index + 1}` }],
    });
  }
  return { model: "claude-opus-5", messages };
}
