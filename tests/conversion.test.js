import test from "node:test";
import assert from "node:assert/strict";

import { buildOpenAIRequest, convertMessages, createStreamConverter, openAIResponseToAnthropic } from "../server.js";

const config = {
  defaultModel: "kimi-k2.6",
  modelMap: new Map([["claude-sonnet-4-5", "kimi-k2.6"]]),
  toolChoicePolicy: "auto-on-forced",
};

test("converts system, assistant text, tool_use, and tool_result blocks", () => {
  const messages = convertMessages(
    [
      { role: "user", content: "Use the weather tool." },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will check it." },
          { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Shanghai" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "Sunny" },
          { type: "text", text: "Summarize it." },
        ],
      },
    ],
    [{ type: "text", text: "You are a coding assistant." }],
  );

  assert.deepEqual(messages, [
    { role: "system", content: "You are a coding assistant." },
    { role: "user", content: "Use the weather tool." },
    {
      role: "assistant",
      content: "I will check it.",
      tool_calls: [
        {
          id: "toolu_1",
          type: "function",
          function: { name: "get_weather", arguments: "{\"city\":\"Shanghai\"}" },
        },
      ],
    },
    { role: "tool", tool_call_id: "toolu_1", content: "Sunny" },
    { role: "user", content: "Summarize it." },
  ]);
});

test("maps Claude-facing model names to upstream model names", () => {
  const { requestedModel, upstreamModel, body } = buildOpenAIRequest(
    {
      model: "claude-sonnet-4-5",
      max_tokens: 128,
      tool_choice: { type: "tool", name: "run_shell" },
      messages: [{ role: "user", content: "hi" }],
    },
    config,
  );

  assert.equal(requestedModel, "claude-sonnet-4-5");
  assert.equal(upstreamModel, "kimi-k2.6");
  assert.equal(body.model, "kimi-k2.6");
  assert.equal(body.tool_choice, "auto");
});

test("passes through real model names when no mapping is configured", () => {
  const { requestedModel, upstreamModel, body } = buildOpenAIRequest(
    {
      model: "kimi-k2.6",
      max_tokens: 128,
      messages: [{ role: "user", content: "hi" }],
    },
    { ...config, modelMap: new Map() },
  );

  assert.equal(requestedModel, "kimi-k2.6");
  assert.equal(upstreamModel, "kimi-k2.6");
  assert.equal(body.model, "kimi-k2.6");
});

test("converts OpenAI tool_calls response to Anthropic tool_use", () => {
  const response = openAIResponseToAnthropic(
    {
      id: "chatcmpl_1",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "Checking.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: "{\"city\":\"Shanghai\"}" },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    },
    "claude-sonnet-4-5",
  );

  assert.equal(response.stop_reason, "tool_use");
  assert.deepEqual(response.content, [
    { type: "text", text: "Checking." },
    { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Shanghai" } },
  ]);
});

test("streams one text content block and ignores duplicate stop chunks", () => {
  const events = [];
  const converter = createStreamConverter("claude-sonnet-4-5", (event, data) => events.push({ event, data }));

  converter.processChunk({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] });
  converter.processChunk({ choices: [{ delta: { content: "stream" }, finish_reason: null }] });
  converter.processChunk({ choices: [{ delta: { content: "-ok" }, finish_reason: null }] });
  converter.processChunk({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 7 } });
  converter.processChunk({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 7 } });
  converter.end();

  assert.deepEqual(
    events.map((item) => item.event),
    ["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"],
  );
  assert.equal(events.filter((item) => item.event === "message_stop").length, 1);
  assert.equal(events[2].data.delta.text + events[3].data.delta.text, "stream-ok");
});

test("streams parallel tool calls by OpenAI index", () => {
  const events = [];
  const converter = createStreamConverter("claude-sonnet-4-5", (event, data) => events.push({ event, data }));

  converter.processChunk({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, id: "call_0", function: { name: "a", arguments: "{\"x\"" } },
            { index: 1, id: "call_1", function: { name: "b", arguments: "{\"y\"" } },
          ],
        },
        finish_reason: null,
      },
    ],
  });
  converter.processChunk({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 1, function: { arguments: ":2}" } },
            { index: 0, function: { arguments: ":1}" } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  });

  const deltasByIndex = new Map();
  for (const item of events.filter((event) => event.event === "content_block_delta")) {
    deltasByIndex.set(item.data.index, (deltasByIndex.get(item.data.index) || "") + item.data.delta.partial_json);
  }

  assert.deepEqual([...deltasByIndex.values()].sort(), ["{\"x\":1}", "{\"y\":2}"]);
});
