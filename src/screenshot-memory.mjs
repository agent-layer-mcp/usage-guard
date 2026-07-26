import { createHash } from "node:crypto";

const DEFAULT_RETENTION_TURNS = 5;
const DEFAULT_USER_CONTEXT_CHARS = 500;
const DEFAULT_ASSISTANT_CONTEXT_CHARS = 1_200;
const PIN_MARKERS = [
  "[usage-guard:pin-images]",
  "[usage-guard:pin-screenshots]",
  "#keep-screenshot",
];

export function transformScreenshotMemory(input, options = {}) {
  if (!input || typeof input !== "object" || !Array.isArray(input.messages)) {
    return unchanged(input, options);
  }

  const retentionTurns = positiveInteger(
    options.retentionTurns,
    DEFAULT_RETENTION_TURNS,
  );
  const userContextChars = positiveInteger(
    options.userContextChars,
    DEFAULT_USER_CONTEXT_CHARS,
  );
  const assistantContextChars = positiveInteger(
    options.assistantContextChars,
    DEFAULT_ASSISTANT_CONTEXT_CHARS,
  );
  const messages = structuredClone(input.messages);
  const userIndexes = messages
    .map((message, index) => message?.role === "user" ? index : -1)
    .filter((index) => index >= 0);
  let imagesReplaced = 0;
  let imageBytesReplaced = 0;
  const replacements = [];

  for (const [userPosition, messageIndex] of userIndexes.entries()) {
    const message = messages[messageIndex];
    if (!Array.isArray(message.content)) continue;
    const ageInUserTurns = userIndexes.length - userPosition - 1;
    if (ageInUserTurns < retentionTurns) continue;

    const userContext = textFromContent(message.content);
    if (isPinned(userContext, options.pinMarkers)) continue;
    const assistantContext = firstAssistantTextAfter(messages, messageIndex);

    message.content = message.content.map((block) => {
      if (!isBase64Image(block)) return block;
      const bytes = decodedByteLength(block.source.data);
      const id = imageId(block.source.data);
      const memory = buildScreenshotMemory({
        id,
        ageInUserTurns,
        mediaType: block.source.media_type,
        bytes,
        userContext: truncate(userContext, userContextChars),
        assistantContext: truncate(assistantContext, assistantContextChars),
      });
      imagesReplaced += 1;
      imageBytesReplaced += bytes;
      replacements.push({
        id,
        ageInUserTurns,
        bytes,
        mediaType: block.source.media_type,
      });
      return {
        type: "text",
        text: memory,
        ...(block.cache_control ? { cache_control: block.cache_control } : {}),
      };
    });
  }

  if (!imagesReplaced) return unchanged(input, { retentionTurns });
  return {
    body: { ...input, messages },
    applied: true,
    info: {
      retentionTurns,
      imagesReplaced,
      imageBytesReplaced,
      replacements,
    },
  };
}

export function isScreenshotMemoryRequest(pathname, method = "GET") {
  if (String(method).toUpperCase() !== "POST") return false;
  return pathname === "/v1/messages"
    || pathname === "/v1/messages/count_tokens";
}

function buildScreenshotMemory({
  id,
  ageInUserTurns,
  mediaType,
  bytes,
  userContext,
  assistantContext,
}) {
  const lines = [
    `<usage_guard_screenshot_memory id="${id}">`,
    `The original ${mediaType || "image"} screenshot was removed from this request after ${ageInUserTurns} later user turns to reduce repeated vision-context cost.`,
  ];
  if (userContext) lines.push(`Original user context: ${userContext}`);
  if (assistantContext) {
    lines.push(`Assistant interpretation from the first response after the screenshot: ${assistantContext}`);
  } else {
    lines.push("No assistant interpretation was available. Ask the user to reattach the screenshot if its pixels are needed again.");
  }
  lines.push(`Original payload: ${formatBytes(bytes)}. This summary is contextual memory, not a byte-exact transcription of the image.`);
  lines.push("</usage_guard_screenshot_memory>");
  return lines.join("\n");
}

function firstAssistantTextAfter(messages, messageIndex) {
  for (let index = messageIndex + 1; index < messages.length; index += 1) {
    if (messages[index]?.role === "user") return "";
    if (messages[index]?.role !== "assistant") continue;
    const text = textFromContent(messages[index].content);
    if (text) return text;
  }
  return "";
}

function textFromContent(content) {
  if (typeof content === "string") return normalizeText(content);
  if (!Array.isArray(content)) return "";
  return normalizeText(content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n"));
}

function normalizeText(value) {
  return String(value || "")
    .replace(/<usage_guard_screenshot_memory[\s\S]*?<\/usage_guard_screenshot_memory>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isPinned(userContext, customMarkers) {
  const markers = Array.isArray(customMarkers) && customMarkers.length
    ? customMarkers
    : PIN_MARKERS;
  const normalized = userContext.toLowerCase();
  return markers.some((marker) => normalized.includes(String(marker).toLowerCase()));
}

function isBase64Image(block) {
  return block?.type === "image"
    && block.source?.type === "base64"
    && typeof block.source.data === "string"
    && /^image\//.test(block.source.media_type || "");
}

function imageId(data) {
  return `sha256:${createHash("sha256").update(data).digest("hex").slice(0, 12)}`;
}

function decodedByteLength(data) {
  const normalized = data.replace(/\s+/g, "");
  if (!normalized) return 0;
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(normalized.length * 3 / 4) - padding);
}

function truncate(value, maxChars) {
  if (!value || value.length <= maxChars) return value;
  const clipped = value.slice(0, Math.max(1, maxChars - 1)).trimEnd();
  return `${clipped}…`;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.round(number);
}

function formatBytes(bytes) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function unchanged(body, options = {}) {
  return {
    body,
    applied: false,
    info: {
      retentionTurns: positiveInteger(
        options.retentionTurns,
        DEFAULT_RETENTION_TURNS,
      ),
      imagesReplaced: 0,
      imageBytesReplaced: 0,
      replacements: [],
    },
  };
}
