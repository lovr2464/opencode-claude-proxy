import test from "node:test";
import assert from "node:assert/strict";

import { buildOpenAIRequest, convertMessages, convertTools, openAIResponseToAnthropic } from "../src/convert.js";
import { createStreamConverter } from "../src/stream.js";

const config = {
  defaultModel: "kimi-k2.6",
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
      reasoning_content: " ",
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

test("passes model name through to upstream unchanged", () => {
  const { model, body } = buildOpenAIRequest(
    {
      model: "deepseek-v4-pro",
      max_tokens: 128,
      tool_choice: { type: "tool", name: "run_shell" },
      messages: [{ role: "user", content: "hi" }],
    },
    config,
  );

  assert.equal(model, "deepseek-v4-pro");
  assert.equal(body.model, "deepseek-v4-pro");
  assert.equal(body.tool_choice, "auto");
});

test("uses defaultModel when no model in request", () => {
  const { model, body } = buildOpenAIRequest(
    {
      max_tokens: 128,
      messages: [{ role: "user", content: "hi" }],
    },
    config,
  );

  assert.equal(model, "kimi-k2.6");
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

test("buffers streamed tool arguments until the tool name is known", () => {
  const events = [];
  const converter = createStreamConverter("claude-sonnet-4-5", (event, data) => events.push({ event, data }));

  converter.processChunk({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"command\"" } }] }, finish_reason: null }],
  });
  converter.processChunk({
    choices: [{ delta: { tool_calls: [{ index: 0, id: "call_late", function: { name: "Bash", arguments: ":\"pwd\"}" } }] }, finish_reason: "tool_calls" }],
  });
  converter.end();

  const start = events.find((item) => item.event === "content_block_start");
  assert.equal(start.data.content_block.id, "call_late");
  assert.equal(start.data.content_block.name, "Bash");

  const partialJson = events
    .filter((item) => item.event === "content_block_delta")
    .map((item) => item.data.delta.partial_json)
    .join("");
  assert.equal(partialJson, "{\"command\":\"pwd\"}");
});

test("converts Anthropic thinking blocks to OpenAI reasoning_content", () => {
  const messages = convertMessages(
    [
      { role: "user", content: "Explain quantum physics." },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Quantum physics is complex.", signature: "sig1" },
          { type: "thinking", thinking: "I need to start with basic concepts.", signature: "sig2" },
          { type: "text", text: "Let me explain step by step." },
        ],
      },
    ],
    undefined,
    "auto",
  );

  assert.deepEqual(messages, [
    { role: "user", content: "Explain quantum physics." },
    {
      role: "assistant",
      content: "Let me explain step by step.",
      reasoning_content: "Quantum physics is complex.\nI need to start with basic concepts.",
    },
  ]);
});

test("injects empty reasoning_content on assistant tool-call messages (auto mode)", () => {
  const messages = convertMessages(
    [
      { role: "user", content: "Search for opencode." },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_1", name: "search", input: { query: "opencode" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Found results." }],
      },
    ],
    undefined,
    "auto",
  );

  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].reasoning_content, " ");
  assert.equal(messages[1].tool_calls.length, 1);
});

test("drops thinking blocks in drop mode", () => {
  const messages = convertMessages(
    [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should use a tool.", signature: "sig1" },
          { type: "text", text: "Let me search." },
          { type: "tool_use", id: "toolu_1", name: "search", input: { query: "test" } },
        ],
      },
    ],
    undefined,
    "drop",
  );

  // In drop mode: no reasoning_content, but still has content and tool_calls
  const msg = messages[0];
  assert.equal(msg.role, "assistant");
  assert.equal(msg.content, "Let me search.");
  assert.equal(msg.reasoning_content, undefined);
  assert.equal(msg.tool_calls.length, 1);
});

test("converts OpenAI reasoning_content to Anthropic thinking block", () => {
  const response = openAIResponseToAnthropic(
    {
      id: "chatcmpl_1",
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "The answer is 42.",
            reasoning_content: "Let me think about this carefully.",
          },
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 15 },
    },
    "kimi-k2.6",
    "auto",
  );

  assert.deepEqual(response.content, [
    { type: "thinking", thinking: "Let me think about this carefully.", signature: "" },
    { type: "text", text: "The answer is 42." },
  ]);
});

test("converts OpenAI reasoning field to Anthropic thinking block", () => {
  const response = openAIResponseToAnthropic(
    {
      id: "chatcmpl_reasoning",
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "Done.",
            reasoning: "Provider-specific reasoning field.",
          },
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 15 },
    },
    "kimi-k2.6",
    "auto",
  );

  assert.deepEqual(response.content, [
    { type: "thinking", thinking: "Provider-specific reasoning field.", signature: "" },
    { type: "text", text: "Done." },
  ]);
});

test("preserves tool_result is_error as tool-message text", () => {
  const messages = convertMessages([
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_error", content: "command failed", is_error: true }],
    },
  ]);

  assert.equal(messages[0].role, "tool");
  assert.equal(messages[0].tool_call_id, "toolu_error");
  assert.equal(messages[0].content, "[Tool error]\ncommand failed");
});

test("streams reasoning_content as thinking blocks", () => {
  const events = [];
  const converter = createStreamConverter("kimi-k2.6", (event, data) => events.push({ event, data }), "auto");

  converter.processChunk({ choices: [{ delta: { reasoning_content: "Let me think" } }] });
  converter.processChunk({ choices: [{ delta: { reasoning_content: " about this." } }] });
  converter.processChunk({ choices: [{ delta: { content: "Answer: 42" } }] });
  converter.processChunk({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 6 } });
  converter.end();

  const blockStarts = events.filter((e) => e.event === "content_block_start");
  assert.equal(blockStarts.length, 2); // thinking + text

  // First block should be thinking
  assert.equal(blockStarts[0].data.content_block.type, "thinking");

  // Collect thinking deltas
  const thinkingText = events
    .filter((e) => e.event === "content_block_delta" && e.data.delta.type === "thinking_delta")
    .map((e) => e.data.delta.thinking)
    .join("");
  assert.equal(thinkingText, "Let me think about this.");

  // Collect text deltas
  const textContent = events
    .filter((e) => e.event === "content_block_delta" && e.data.delta.type === "text_delta")
    .map((e) => e.data.delta.text)
    .join("");
  assert.equal(textContent, "Answer: 42");

  // Verify correct event sequence
  const eventNames = events.map((e) => e.event);
  assert.deepEqual(eventNames, [
    "message_start",
    "content_block_start",  // thinking
    "content_block_delta",   // thinking_delta
    "content_block_delta",   // thinking_delta
    "content_block_stop",    // thinking closed
    "content_block_start",   // text
    "content_block_delta",   // text_delta
    "content_block_stop",    // text closed
    "message_delta",
    "message_stop",
  ]);
});

test("streaming drop mode skips reasoning_content", () => {
  const events = [];
  const converter = createStreamConverter("kimi-k2.6", (event, data) => events.push({ event, data }), "drop");

  converter.processChunk({ choices: [{ delta: { reasoning_content: "Hidden reasoning" } }] });
  converter.processChunk({ choices: [{ delta: { content: "Hello" } }] });
  converter.processChunk({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2 } });
  converter.end();

  // No thinking blocks should appear
  const thinkingEvents = events.filter((e) => e.data?.delta?.type === "thinking_delta");
  assert.equal(thinkingEvents.length, 0);

  // Text should still work
  const textDeltas = events.filter((e) => e.data?.delta?.type === "text_delta");
  assert.equal(textDeltas.length, 1);
  assert.equal(textDeltas[0].data.delta.text, "Hello");
});

test("normalizes tool parameters with type and properties for Moonshot compatibility", () => {
  const tools = convertTools([
    {
      name: "get_weather",
      description: "Get weather",
      input_schema: { description: "Weather params" }, // missing type and properties
    },
    {
      name: "no_schema",
      description: "No schema tool",
      // input_schema is missing entirely
    },
    {
      name: "valid_schema",
      description: "Valid schema",
      input_schema: { type: "object", properties: { city: { type: "string" } } },
    },
  ]);

  assert.equal(tools.length, 3);
  assert.equal(tools[0].function.parameters.type, "object");
  assert.deepEqual(tools[0].function.parameters.properties, {});
  assert.equal(tools[0].function.parameters.description, "Weather params");

  assert.equal(tools[1].function.parameters.type, "object");
  assert.deepEqual(tools[1].function.parameters.properties, {});

  assert.equal(tools[2].function.parameters.type, "object");
  assert.deepEqual(tools[2].function.parameters.properties, { city: { type: "string" } });
});

test("sanitizes MFJS schema: strips unsupported keywords and normalizes type arrays", () => {
  const tools = convertTools([
    {
      name: "complex_tool",
      description: "Complex tool",
      input_schema: {
        type: "object",
        properties: {
          name: { type: ["string", "null"], format: "email", minLength: 1 },
          count: { type: "integer", allOf: [{ minimum: 0 }] },
          nested: {
            type: "object",
            properties: {
              $ref: { type: "string" }, // invalid property name
              value: { type: "number", exclusiveMinimum: 0 },
            },
            required: ["value", "missing"],
          },
        },
        required: ["name", "nonexistent"],
      },
    },
  ]);

  const params = tools[0].function.parameters;

  // Root type and properties preserved
  assert.equal(params.type, "object");
  assert.ok(params.properties.name);
  assert.ok(params.properties.count);
  assert.ok(params.properties.nested);

  // Type array normalized to single string
  assert.equal(params.properties.name.type, "string");

  // Unsupported keywords removed
  assert.equal(params.properties.name.format, undefined);
  assert.equal(params.properties.count.allOf, undefined);

  // Nested object cleaned
  assert.equal(params.properties.nested.properties.$ref, undefined);
  assert.equal(params.properties.nested.properties.value.type, "number");
  assert.equal(params.properties.nested.properties.value.exclusiveMinimum, undefined);

  // Missing required props are auto-created so required stays intact
  assert.deepEqual(params.required, ["name", "nonexistent"]);
  assert.ok(params.properties.nonexistent);

  assert.deepEqual(params.properties.nested.required, ["value", "missing"]);
  assert.ok(params.properties.nested.properties.missing);
});

test("sanitizes MFJS schema: handles null and missing input_schema", () => {
  const tools = convertTools([
    { name: "a", input_schema: null },
    { name: "b", input_schema: undefined },
    { name: "c", input_schema: "not an object" },
    { name: "d", input_schema: [1, 2, 3] },
  ]);

  for (const tool of tools) {
    assert.equal(tool.function.parameters.type, "object");
    assert.deepEqual(tool.function.parameters.properties, {});
  }
});

test("sanitizes MFJS schema: auto-simplifies when schema exceeds 14 KB", () => {
  // Build a huge schema with many long descriptions
  const bigProps = {};
  for (let i = 0; i < 200; i++) {
    bigProps[`field_${i}`] = {
      type: "string",
      description: "a".repeat(200),
    };
  }
  const tools = convertTools([
    {
      name: "huge_tool",
      input_schema: {
        type: "object",
        properties: bigProps,
      },
    },
  ]);

  const params = tools[0].function.parameters;
  const size = JSON.stringify(params).length;
  assert.ok(size <= 15000, `Schema size ${size} exceeds 15000 bytes`);
  assert.equal(params.type, "object");
});

test("sanitizes MFJS schema: removes type when anyOf is present", () => {
  const tools = convertTools([
    {
      name: "status_tool",
      input_schema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            anyOf: [
              { enum: ["active"], description: "Active state" },
              { enum: ["inactive"], description: "Inactive state" },
            ],
          },
        },
      },
    },
  ]);

  const statusSchema = tools[0].function.parameters.properties.status;
  assert.equal(statusSchema.type, undefined);
  assert.equal(statusSchema.anyOf.length, 2);
});

test("sanitizes MFJS schema: removes type when $ref is present", () => {
  const tools = convertTools([
    {
      name: "ref_tool",
      input_schema: {
        type: "object",
        properties: {
          data: {
            type: "object",
            $ref: "#/$defs/Data",
          },
        },
        $defs: {
          Data: { type: "string" },
        },
      },
    },
  ]);

  const dataSchema = tools[0].function.parameters.properties.data;
  assert.equal(dataSchema.type, undefined);
  assert.equal(dataSchema.$ref, "#/$defs/Data");
});

test("sanitizes MFJS schema: pushes parent properties into anyOf branches", () => {
  const tools = convertTools([
    {
      name: "parent_anyof_tool",
      input_schema: {
        type: "object",
        properties: {
          parent: {
            type: "object",
            properties: {
              id: { type: "string" },
            },
            anyOf: [
              { properties: { name: { type: "string" } } },
              { properties: { age: { type: "integer" } } },
            ],
          },
        },
      },
    },
  ]);

  const parentSchema = tools[0].function.parameters.properties.parent;
  // Parent should have lost its own properties/type because anyOf exists
  assert.equal(parentSchema.properties, undefined);
  assert.equal(parentSchema.type, undefined);

  // Each branch should contain merged properties
  assert.equal(parentSchema.anyOf.length, 2);
  assert.ok(parentSchema.anyOf[0].properties.id);
  assert.ok(parentSchema.anyOf[0].properties.name);
  assert.ok(parentSchema.anyOf[1].properties.id);
  assert.ok(parentSchema.anyOf[1].properties.age);
});

test("sanitizes MFJS schema: pushes parent required into anyOf branches", () => {
  const tools = convertTools([
    {
      name: "req_anyof_tool",
      input_schema: {
        type: "object",
        properties: {
          action: {
            type: "object",
            properties: {
              cmd: { type: "string" },
              path: { type: "string" },
            },
            required: ["cmd"],
            anyOf: [
              { required: ["path"] },
              { required: ["url"] },
            ],
          },
        },
      },
    },
  ]);

  const actionSchema = tools[0].function.parameters.properties.action;
  assert.equal(actionSchema.required, undefined);
  assert.deepEqual(actionSchema.anyOf[0].required.sort(), ["cmd", "path"]);
  assert.deepEqual(actionSchema.anyOf[1].required.sort(), ["cmd", "url"]);
});
