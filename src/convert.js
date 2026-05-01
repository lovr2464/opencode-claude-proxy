
/**
 * Convert Anthropic tools to OpenAI function tools.
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
        parameters: tool.input_schema || { type: "object", properties: {} },
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
      message.reasoning_content = reasoningContent || " ";
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
    max_tokens: anthropicReq.max_tokens || 4096,
    stream: anthropicReq.stream === true,
  };

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
