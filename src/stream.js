import { finishReasonToStopReason, makeMsgId } from "./convert.js";

/**
 * Creates a stateful streaming converter that translates OpenAI SSE chunks
 * into Anthropic SSE events.
 *
 * Handles:
 * - Reasoning content → Anthropic thinking blocks
 * - Text content → text blocks
 * - Tool calls → tool_use blocks (grouped by OpenAI index)
 * - Deduplication of finish_reason and usage-only chunks
 */
export function createStreamConverter(model, onEvent, reasoningMode = "auto") {
  const msgId = makeMsgId();
  const toolBlocks = new Map();
  let started = false;
  let finalized = false;
  let nextContentIndex = 0;
  let textBlockIndex = null;
  let thinkingBlockIndex = null;
  let reasoningActive = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let pendingFinishReason = null;

  function ensureStarted() {
    if (started) return;
    started = true;
    onEvent("message_start", {
      type: "message_start",
      message: { id: msgId, type: "message", role: "assistant", model, content: [], usage: { input_tokens: inputTokens } },
    });
  }

  function closeTextBlock() {
    if (textBlockIndex === null) return;
    onEvent("content_block_stop", { type: "content_block_stop", index: textBlockIndex });
    textBlockIndex = null;
  }

  function closeThinkingBlock() {
    if (thinkingBlockIndex === null) return;
    onEvent("content_block_stop", { type: "content_block_stop", index: thinkingBlockIndex });
    thinkingBlockIndex = null;
    reasoningActive = false;
  }

  function ensureTextBlock() {
    if (textBlockIndex !== null) return textBlockIndex;
    const index = nextContentIndex++;
    textBlockIndex = index;
    onEvent("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    });
    return index;
  }

  function ensureThinkingBlock() {
    if (thinkingBlockIndex !== null) return thinkingBlockIndex;
    closeTextBlock();
    const index = nextContentIndex++;
    thinkingBlockIndex = index;
    reasoningActive = true;
    onEvent("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "", signature: "" },
    });
    return index;
  }

  function ensureToolBlock(toolDelta) {
    const openaiIndex = toolDelta.index ?? 0;
    if (toolBlocks.has(openaiIndex)) return toolBlocks.get(openaiIndex);

    const block = {
      index: null,
      openaiIndex,
      id: toolDelta.id || null,
      name: toolDelta.function?.name || null,
      pendingJson: "",
      started: false,
    };
    toolBlocks.set(openaiIndex, block);
    return block;
  }

  function startToolBlock(block) {
    if (block.started) return;
    closeTextBlock();
    closeThinkingBlock();
    block.index = nextContentIndex++;
    block.id ||= `toolu_${Date.now().toString(36)}_${block.openaiIndex}`;
    block.name ||= "unknown_tool";
    block.started = true;
    onEvent("content_block_start", {
      type: "content_block_start",
      index: block.index,
      content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
    });
    if (block.pendingJson) {
      onEvent("content_block_delta", {
        type: "content_block_delta",
        index: block.index,
        delta: { type: "input_json_delta", partial_json: block.pendingJson },
      });
      block.pendingJson = "";
    }
  }

  function closeToolBlocks() {
    for (const block of toolBlocks.values()) {
      startToolBlock(block);
      onEvent("content_block_stop", { type: "content_block_stop", index: block.index });
    }
    toolBlocks.clear();
  }

  function finalize(reason = "stop", usage = {}) {
    if (finalized) return;
    finalized = true;
    ensureStarted();
    closeThinkingBlock();
    closeTextBlock();
    closeToolBlocks();
    onEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: finishReasonToStopReason(reason), stop_sequence: null },
      usage: { output_tokens: usage.completion_tokens ?? outputTokens },
    });
    onEvent("message_stop", { type: "message_stop" });
  }

  return {
    processChunk(chunk) {
      if (finalized) return;

      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
        outputTokens = chunk.usage.completion_tokens ?? outputTokens;
      }

      const choice = chunk.choices?.[0];
      if (!choice) return;

      ensureStarted();
      const delta = choice.delta || {};

      // Reasoning content → Anthropic thinking block
      const reasoningDelta = delta.reasoning_content || delta.reasoning;
      if (reasoningDelta && reasoningMode !== "drop") {
        const index = ensureThinkingBlock();
        onEvent("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking: reasoningDelta },
        });
      }

      // When content or tool calls arrive after reasoning, close the thinking block
      if ((delta.content || delta.tool_calls?.length) && reasoningActive) {
        closeThinkingBlock();
      }

      if (delta.content) {
        const index = ensureTextBlock();
        onEvent("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: delta.content },
        });
      }

      for (const toolDelta of delta.tool_calls || []) {
        const block = ensureToolBlock(toolDelta);
        if (toolDelta.id) block.id = toolDelta.id;
        if (toolDelta.function?.name) block.name = toolDelta.function.name;
        if (toolDelta.function?.arguments) {
          if (block.started) {
            onEvent("content_block_delta", {
              type: "content_block_delta",
              index: block.index,
              delta: { type: "input_json_delta", partial_json: toolDelta.function.arguments },
            });
          } else {
            block.pendingJson += toolDelta.function.arguments;
          }
        }
        if (!block.started && block.name) startToolBlock(block);
      }

      if (choice.finish_reason) {
        pendingFinishReason = choice.finish_reason;
        if (chunk.usage) finalize(choice.finish_reason, chunk.usage);
      }
    },
    end() {
      if (started && !finalized) finalize(pendingFinishReason || "stop");
    },
  };
}
