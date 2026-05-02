
let lastReasoningContent = ""; // cache for DeepSeek reasoning echo requirement

// ── Moonshot Flavored JSON Schema (MFJS) sanitization ──────────────────────

const MFJS_SUPPORTED = new Set([
  "type", "properties", "additionalProperties", "items", "enum",
  "required", "anyOf", "description", "$defs", "$ref", "title",
  "$id", "default", "maxLength", "minLength", "maximum", "minimum",
  "maxItems", "minItems", "pattern",
]);

const MFJS_VALID_TYPES = new Set([
  "string", "number", "integer", "boolean", "null", "array", "object",
]);

const MFJS_INVALID_PROP_NAMES = new Set([
  "$defs", "$ref", "anyOf", "required", "additionalProperties",
]);

function isInvalidPropertyName(name) {
  if (MFJS_INVALID_PROP_NAMES.has(name)) return true;
  // Moonshot path resolver treats {} as anyOf index markers, so property names
  // containing braces cause "invalid path" errors.
  if (name.includes("{") || name.includes("}")) return true;
  return false;
}

const MFJS_MAX_DEPTH = 64;
const MFJS_MAX_SCHEMA_SIZE = 14000; // 14 KB, leave 1 KB headroom

function schemaSize(schema) {
  return JSON.stringify(schema).length;
}

function normalizeMFJSType(typeValue) {
  if (typeof typeValue === "string") {
    return MFJS_VALID_TYPES.has(typeValue) ? typeValue : "object";
  }
  if (Array.isArray(typeValue)) {
    const nonNull = typeValue.find((t) => t !== "null" && MFJS_VALID_TYPES.has(t));
    return nonNull || "string";
  }
  return "object";
}

/**
 * Progressive simplification: when a schema is still too large after
 * normal sanitization, strip descriptions, then flatten nested objects,
 * then fall back to a minimal {} schema.
 */
function simplifyForSize(schema) {
  // Phase 1: strip all descriptions recursively
  function stripDescriptions(s) {
    if (!s || typeof s !== "object" || Array.isArray(s)) return s;
    const out = {};
    for (const [k, v] of Object.entries(s)) {
      if (k === "description" || k === "title" || k === "$id" || k === "default") continue;
      if (k === "properties" && v && typeof v === "object") {
        out[k] = {};
        for (const [pk, pv] of Object.entries(v)) {
          out[k][pk] = stripDescriptions(pv);
        }
      } else if (k === "items" && v && typeof v === "object" && !Array.isArray(v)) {
        out[k] = stripDescriptions(v);
      } else if (k === "anyOf" && Array.isArray(v)) {
        out[k] = v.map((item) => stripDescriptions(item));
      } else if (k === "$defs" && v && typeof v === "object") {
        out[k] = {};
        for (const [dk, dv] of Object.entries(v)) {
          out[k][dk] = stripDescriptions(dv);
        }
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  let result = stripDescriptions(schema);
  if (schemaSize(result) <= MFJS_MAX_SCHEMA_SIZE) return result;

  // Phase 2: flatten any nested object properties to { type: "object" }
  function flattenObjects(s, depth = 0) {
    if (!s || typeof s !== "object" || Array.isArray(s)) return s;
    if (depth >= 3) {
      // At depth >= 3, replace any object schema with a minimal one
      const t = s.type;
      if (t === "object") return { type: "object", properties: {} };
      if (t === "array") return { type: "array", items: { type: "string" } };
      if (MFJS_VALID_TYPES.has(t)) return { type: t };
      return { type: "string" };
    }
    const out = {};
    for (const [k, v] of Object.entries(s)) {
      if (k === "properties" && v && typeof v === "object") {
        out[k] = {};
        for (const [pk, pv] of Object.entries(v)) {
          out[k][pk] = flattenObjects(pv, depth + 1);
        }
      } else if (k === "items" && v && typeof v === "object" && !Array.isArray(v)) {
        out[k] = flattenObjects(v, depth + 1);
      } else if (k === "anyOf" && Array.isArray(v)) {
        out[k] = v.map((item) => flattenObjects(item, depth + 1));
      } else if (k === "$defs" && v && typeof v === "object") {
        out[k] = {};
        for (const [dk, dv] of Object.entries(v)) {
          out[k][dk] = flattenObjects(dv, depth + 1);
        }
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  result = flattenObjects(result);
  if (schemaSize(result) <= MFJS_MAX_SCHEMA_SIZE) return result;

  // Phase 3: flatten everything at depth >= 2
  function flattenAll(s, depth = 0) {
    if (!s || typeof s !== "object" || Array.isArray(s)) return s;
    if (depth >= 2) {
      const t = s.type;
      if (t === "object") return { type: "object", properties: {} };
      if (t === "array") return { type: "array", items: { type: "string" } };
      if (MFJS_VALID_TYPES.has(t)) return { type: t };
      return { type: "string" };
    }
    const out = {};
    for (const [k, v] of Object.entries(s)) {
      if (k === "properties" && v && typeof v === "object") {
        out[k] = {};
        for (const [pk, pv] of Object.entries(v)) {
          out[k][pk] = flattenAll(pv, depth + 1);
        }
      } else if (k === "items" && v && typeof v === "object" && !Array.isArray(v)) {
        out[k] = flattenAll(v, depth + 1);
      } else if (k === "anyOf" && Array.isArray(v)) {
        out[k] = v.map((item) => flattenAll(item, depth + 1));
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  result = flattenAll(result);
  if (schemaSize(result) <= MFJS_MAX_SCHEMA_SIZE) return result;

  // Phase 4: nuclear option - empty object schema
  return { type: "object", properties: {} };
}

export function sanitizeForMoonshot(schema, depth = 0) {
  if (depth > MFJS_MAX_DEPTH) return { type: "object", properties: {} };
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }

  const result = {};

  // 1. Keep only supported keywords
  for (const key of Object.keys(schema)) {
    if (MFJS_SUPPORTED.has(key)) {
      result[key] = schema[key];
    }
  }

  // 2. MFJS rule: when anyOf is present, parent-level keywords that overlap
  //    with branch keywords cause "conflicting keywords found in anyOf".
  //    Push parent keywords into each branch, then delete from parent.
  if (Array.isArray(result.anyOf)) {
    const parentKeys = Object.keys(result).filter(
      (k) => k !== "anyOf" && k !== "description" && k !== "title" && k !== "$defs",
    );
    for (const key of parentKeys) {
      for (const branch of result.anyOf) {
        if (!branch || typeof branch !== "object" || Array.isArray(branch)) continue;
        if (branch[key] === undefined) {
          branch[key] = result[key];
        } else if (key === "properties") {
          branch[key] = { ...result[key], ...branch[key] };
        } else if (key === "required") {
          const parentReq = Array.isArray(result[key]) ? result[key] : [];
          const branchReq = Array.isArray(branch[key]) ? branch[key] : [];
          branch[key] = [...new Set([...parentReq, ...branchReq])];
        }
        // For other keys (type, items, etc.) branch takes precedence
      }
      delete result[key];
    }

    // Recursively clean anyOf branches
    result.anyOf = result.anyOf
      .filter((item) => item && typeof item === "object" && !Array.isArray(item))
      .map((item) => sanitizeForMoonshot(item, depth + 1));
    if (result.anyOf.length === 0) {
      delete result.anyOf;
    }
  }

  // 3. Normalize type to a single string (default to object when missing)
  if (result.type !== undefined) {
    result.type = normalizeMFJSType(result.type);
  } else if (!result.anyOf && !result.$ref) {
    result.type = "object";
  }

  // 4. Ensure properties exists for object schemas
  if (result.type === "object" && (!result.properties || typeof result.properties !== "object" || Array.isArray(result.properties))) {
    result.properties = {};
  }

  // 5. Ensure required is a subset of properties (auto-create missing ones)
  if (Array.isArray(result.required) && result.properties && typeof result.properties === "object") {
    for (const req of result.required) {
      if (typeof req === "string" && !Object.prototype.hasOwnProperty.call(result.properties, req)) {
        result.properties[req] = {};
      }
    }
    const propNames = new Set(Object.keys(result.properties));
    result.required = result.required.filter((r) => typeof r === "string" && propNames.has(r));
    if (result.required.length === 0) {
      delete result.required;
    }
  }

  // 6. Recursively clean properties (and drop invalid property names)
  if (result.properties && typeof result.properties === "object") {
    const cleanedProps = {};
    for (const [propName, propSchema] of Object.entries(result.properties)) {
      if (!isInvalidPropertyName(propName)) {
        cleanedProps[propName] = sanitizeForMoonshot(propSchema, depth + 1);
      }
    }
    result.properties = cleanedProps;
  }

  // 7. Recursively clean items
  if (result.items && typeof result.items === "object" && !Array.isArray(result.items)) {
    result.items = sanitizeForMoonshot(result.items, depth + 1);
  }

  // 8. Recursively clean additionalProperties (if object)
  if (result.additionalProperties && typeof result.additionalProperties === "object" && !Array.isArray(result.additionalProperties)) {
    result.additionalProperties = sanitizeForMoonshot(result.additionalProperties, depth + 1);
  }

  // 9. Recursively clean $defs
  if (result.$defs && typeof result.$defs === "object" && !Array.isArray(result.$defs)) {
    const cleanedDefs = {};
    for (const [defName, defSchema] of Object.entries(result.$defs)) {
      if (defName && typeof defName === "string" && !defName.includes("/") && !defName.includes("{") && !defName.includes("}")) {
        cleanedDefs[defName] = sanitizeForMoonshot(defSchema, depth + 1);
      }
    }
    result.$defs = cleanedDefs;
  }

  // 10. MFJS rule: type cannot coexist with $ref in the same schema
  if (result.$ref && result.type) {
    delete result.type;
  }

  // 11. Size guard: Moonshot enforces a 15000-byte JSON limit on the schema.
  //     If we exceed it, progressively strip descriptions, flatten nested
  //     objects, and finally fall back to a minimal {} schema.
  if (schemaSize(result) > MFJS_MAX_SCHEMA_SIZE) {
    return simplifyForSize(result);
  }

  return result;
}

/**
 * Convert Anthropic tools to OpenAI function tools.
 *
 * Moonshot/Kimi requires parameters to explicitly declare type: "object"
 * and a properties field (even if empty), otherwise it rejects the request
 * with "tools.function.parameters is not a valid moonshot flavored ...".
 */
export function convertTools(anthropicTools) {
  if (!anthropicTools?.length) return [];

  return anthropicTools
    .filter((tool) => tool?.name)
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: sanitizeForMoonshot(tool.input_schema),
      },
    }));
}

// ── Message conversion helpers ──────────────────────────────────────────────

function anthropicSystemToOpenAI(systemPrompt) {
  if (!systemPrompt) return null;
  if (typeof systemPrompt === "string") return systemPrompt;
  if (!Array.isArray(systemPrompt)) return String(systemPrompt);

  return systemPrompt
    .map((block) => {
      if (typeof block === "string") return block;
      if (block?.type === "text") return block.text || "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function anthropicImageToOpenAI(block) {
  const source = block?.source;
  if (source?.type === "base64" && source.data && source.media_type) {
    return { type: "image_url", image_url: { url: `data:${source.media_type};base64,${source.data}` } };
  }
  if (source?.type === "url" && source.url) {
    return { type: "image_url", image_url: { url: source.url } };
  }
  return { type: "text", text: "[Unsupported image block]" };
}

function stringifyToolResultContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);

  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block?.type === "text") return block.text || "";
      if (block?.type === "image") return "[Image tool result omitted]";
      return JSON.stringify(block);
    })
    .filter(Boolean)
    .join("\n");
}

function annotateToolResultContent(block) {
  const content = stringifyToolResultContent(block.content);
  return block.is_error ? `[Tool error]\n${content}`.trim() : content;
}

function makeAssistantMessage(texts, toolCalls, reasoningContent, reasoningMode) {
  const message = { role: "assistant" };
  const content = texts.filter(Boolean).join("\n");
  if (content) message.content = content;
  if (toolCalls.length) {
    message.tool_calls = toolCalls;
    if (!content) message.content = null;
    if (reasoningMode !== "drop") {
      // Providers like Kimi K2.6 require reasoning_content on assistant
      // tool-call messages when thinking is enabled. Use the extracted
      // Anthropic thinking text when available; otherwise inject a non-empty
      // placeholder because Kimi treats an empty string like a missing field.
      message.reasoning_content = reasoningContent || lastReasoningContent || " ";
    }
  } else if (reasoningContent) {
    // Text-only assistant message that had preceding thinking blocks
    message.reasoning_content = reasoningContent;
  }
  return message;
}

// ── Main conversion functions ───────────────────────────────────────────────

export function convertMessages(anthropicMessages = [], systemPrompt, reasoningMode = "auto") {
  const openaiMessages = [];
  const system = anthropicSystemToOpenAI(systemPrompt);
  if (system) openaiMessages.push({ role: "system", content: system });

  for (const msg of anthropicMessages) {
    if (typeof msg.content === "string") {
      openaiMessages.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (!Array.isArray(msg.content)) continue;

    const texts = [];
    const userContentParts = [];
    const toolCalls = [];
    let thinkingText = "";

    for (const block of msg.content) {
      if (block?.type === "text") {
        texts.push(block.text || "");
        userContentParts.push({ type: "text", text: block.text || "" });
      } else if (block?.type === "image") {
        userContentParts.push(anthropicImageToOpenAI(block));
      } else if (block?.type === "thinking") {
        if (reasoningMode !== "drop") {
          thinkingText += (thinkingText ? "\n" : "") + (block.thinking || "");
        }
      } else if (block?.type === "redacted_thinking") {
        if (reasoningMode !== "drop") {
          thinkingText = thinkingText || "[thinking redacted]";
        }
      } else if (block?.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        });
      } else if (block?.type === "tool_result") {
        openaiMessages.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: annotateToolResultContent(block),
        });
      }
    }

    if (msg.role === "assistant") {
      const assistantMessage = makeAssistantMessage(texts, toolCalls, thinkingText, reasoningMode);
      if (assistantMessage.content !== undefined || assistantMessage.tool_calls?.length) {
        openaiMessages.push(assistantMessage);
      }
    } else if (msg.role === "user") {
      if (userContentParts.length > 0) {
        const onlyText = userContentParts.every((part) => part.type === "text");
        openaiMessages.push({
          role: "user",
          content: onlyText ? userContentParts.map((part) => part.text).join("\n") : userContentParts,
        });
      }
    }
  }

  return openaiMessages;
}

export function finishReasonToStopReason(reason) {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}

export function makeMsgId() {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
}

export function openAIResponseToAnthropic(openaiResp, requestedModel, reasoningMode = "auto") {
  const choice = openaiResp.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];

  // Convert reasoning_content to an Anthropic thinking block
  const reasoning = msg.reasoning_content || msg.reasoning;
  if (reasoning) lastReasoningContent = reasoning; // cache for DeepSeek echo
  if (reasoning && reasoningMode !== "drop") {
    content.push({
      type: "thinking",
      thinking: reasoning,
      signature: "",
    });
  }

  if (typeof msg.content === "string" && msg.content.length > 0) {
    content.push({ type: "text", text: msg.content });
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part?.type === "text" && part.text) content.push({ type: "text", text: part.text });
    }
  }

  for (const toolCall of msg.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(toolCall.function?.arguments || "{}");
    } catch {
      input = { _raw: toolCall.function?.arguments || "" };
    }
    content.push({
      type: "tool_use",
      id: toolCall.id || `toolu_${Date.now().toString(36)}`,
      name: toolCall.function?.name || toolCall.custom?.name || "unknown_tool",
      input,
    });
  }

  return {
    id: openaiResp.id || makeMsgId(),
    type: "message",
    role: "assistant",
    model: requestedModel || openaiResp.model,
    content,
    stop_reason: finishReasonToStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: openaiResp.usage?.prompt_tokens || 0,
      output_tokens: openaiResp.usage?.completion_tokens || 0,
    },
  };
}

function applyToolChoicePolicy(toolChoice, policy) {
  if (!toolChoice) return undefined;

  if (toolChoice.type === "none") return "none";
  if (toolChoice.type === "auto") return "auto";

  if (policy === "drop") return undefined;
  if (policy === "auto-on-forced" && (toolChoice.type === "any" || toolChoice.type === "tool")) return "auto";

  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "tool") return { type: "function", function: { name: toolChoice.name } };
  return undefined;
}

// ── Request builder ─────────────────────────────────────────────────────────

export function buildOpenAIRequest(anthropicReq, config) {
  const model = anthropicReq.model || config.defaultModel;
  const body = {
    model,
    messages: convertMessages(anthropicReq.messages || [], anthropicReq.system, config.reasoningMode),
    stream: anthropicReq.stream === true,
  };
  if (anthropicReq.max_tokens !== undefined) body.max_tokens = anthropicReq.max_tokens;

  for (const [anthropicKey, openaiKey] of [
    ["temperature", "temperature"],
    ["top_p", "top_p"],
    ["stop_sequences", "stop"],
  ]) {
    if (anthropicReq[anthropicKey] !== undefined) body[openaiKey] = anthropicReq[anthropicKey];
  }

  const tools = convertTools(anthropicReq.tools);
  if (tools.length) body.tools = tools;

  const toolChoice = applyToolChoicePolicy(anthropicReq.tool_choice, config.toolChoicePolicy);
  if (toolChoice !== undefined) body.tool_choice = toolChoice;

  if (body.stream) {
    body.stream_options = { include_usage: true };
  }

  return { model, body };
}
