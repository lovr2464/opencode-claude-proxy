# 设计文档：OpenAI 到 Anthropic API 适配器

## 目标

这个适配器让 Claude Code 可以使用 OpenAI 兼容的 Chat Completions 后端，同时 Claude Code 自己仍然按 Anthropic Messages API 的方式工作。

产品边界刻意保持很小：

- 下游接口：Anthropic 兼容的 `/v1/messages`、`/v1/models` 和 `/health`。
- 上游接口：OpenAI 兼容的 `/chat/completions`。
- 配置入口：一个本地 `settings.json` 文件。

OpenCode Go 是一个重要目标，因为它可能通过 OpenAI 兼容接口提供 Kimi、DeepSeek、Qwen 等模型。但设计本身不绑定 OpenCode Go；只要上游足够兼容 OpenAI Chat Completions，就应该可以接入。

## 运行形态

```text
Claude Code
  |
  | Anthropic Messages API
  v
本地适配器
  |
  | OpenAI Chat Completions API
  v
OpenAI 兼容上游
```

推荐模式下，Claude Code 不直接接触上游服务商。它只用占位 API key 和占位模型名访问本地适配器。

## 配置模型

`settings.json` 是适配器唯一的配置文件。

```json
{
  "proxy": {
    "host": "127.0.0.1",
    "port": 8787,
    "authMode": "proxy",
    "requestTimeoutMs": 300000,
    "logLevel": "info"
  },
  "upstream": {
    "baseUrl": "https://opencode.ai/zen/go/v1",
    "apiKey": "your-opencode-go-api-key"
  },
  "model": {
    "claudeId": "opencode-go",
    "upstreamId": "kimi-k2.6",
    "list": ["opencode-go"],
    "map": {
      "opencode-go": "kimi-k2.6"
    }
  }
}
```

Claude Code 有自己的 settings 文件。用户在那里配置：

- `ANTHROPIC_BASE_URL`：本地适配器地址。
- `ANTHROPIC_API_KEY`：`proxy.authMode` 为 `proxy` 时使用占位 key。
- 模型相关变量：占位模型名，通常就是 `model.claudeId`。

这样可以把真实上游密钥留在适配器进程里，同时让 Claude Code 的配置方式保持直观。

## 鉴权模式

支持两种模式：

- `proxy`：适配器使用 `upstream.apiKey` 请求上游。Claude Code 发送任意非空占位 key 即可。
- `passthrough`：适配器把 Claude Code 的 `ANTHROPIC_API_KEY` 作为上游 bearer token 转发。

推荐使用 `proxy`，这样真实上游 key 不需要写进 Claude Code settings。

## 模型映射

Claude Code 请求稳定的 Anthropic 侧模型 id，例如 `opencode-go`。适配器把它映射到真实上游模型 id，例如 `kimi-k2.6`。

解析顺序：

1. `model.map[requestedModel]`
2. `model.map["*"]`
3. 原样使用请求模型名

如果 `model.upstreamId` 和 `model.claudeId` 不同，并且没有显式给 `model.claudeId` 写映射，适配器会在内部自动补一条默认映射。

响应中仍回报 Claude 侧模型名，保证 Claude Code UI 看到的模型名稳定。

## 消息转换

请求转换：

| Anthropic 输入 | OpenAI 输出 |
| --- | --- |
| 顶层 `system` | `role: "system"` 消息 |
| 用户 `text` | 用户文本内容 |
| 用户 `image` URL/base64 | `image_url` 内容块 |
| 助手 `text` | assistant `content` |
| 助手 `tool_use` | assistant `tool_calls` |
| 用户 `tool_result` | 带 `tool_call_id` 的 `role: "tool"` |
| `thinking` / `redacted_thinking` | 启用时转为 `reasoning_content` |

响应转换：

| OpenAI 输入 | Anthropic 输出 |
| --- | --- |
| 助手文本 | `{ "type": "text" }` 块 |
| `tool_calls[]` | `{ "type": "tool_use" }` 块 |
| `finish_reason: "tool_calls"` | `stop_reason: "tool_use"` |
| `reasoning_content` / `reasoning` | `{ "type": "thinking" }` 块 |

工具错误会保留在 tool result 文本中，让下一轮模型可以继续基于失败信息推理。

## 流式转换

OpenAI SSE chunk 会转换为 Anthropic 事件顺序：

1. `message_start`
2. `content_block_start`
3. `content_block_delta`
4. `content_block_stop`
5. `message_delta`
6. `message_stop`

流式转换器处理：

- 文本增量
- reasoning 增量
- 一个或多个工具调用
- 交错的工具调用参数 chunk
- 先流式输出工具参数、后输出工具 id/name 的上游
- 重复 finish chunk
- 只有 usage 的 chunk
- `[DONE]` 和注释行

## 工具选择策略

部分推理模型在启用 thinking 时会拒绝强制工具选择。因此适配器默认采用面向 Claude Code 可用性的策略：

- Anthropic `tool_choice: auto` 保持 OpenAI `auto`。
- Anthropic `tool_choice: any` 转为 OpenAI `auto`。
- Anthropic `tool_choice: tool` 转为 OpenAI `auto`。

这样可以让不支持 reasoning 模式下强制工具选择的上游仍然跑通 Claude Code 工具循环。

## 推理转换

默认模式会双向转换 reasoning：

- Anthropic `thinking` 块转为 OpenAI `reasoning_content`。
- OpenAI `reasoning_content` 或提供商特有的 `reasoning` 字段转为 Anthropic `thinking` 块。
- 为了兼容部分推理模型，助手工具调用消息会按需补 `reasoning_content`。

Anthropic thinking signature 会输出为空字符串，因为 OpenAI 兼容上游没有 Anthropic 的 signature 机制。

## 错误处理

适配器会把错误归一化为 Anthropic 格式：

```json
{
  "type": "error",
  "error": {
    "type": "api_error",
    "message": "..."
  }
}
```

如果上游返回 200 但 body 不是有效的 Chat Completions 成功响应，适配器会把它当作上游失败，而不是返回空 assistant 消息。

## 当前限制

- 未实现 Anthropic 服务端托管工具，例如 web search 和 code execution。
- 图片转换是尽力而为；文本和工具工作流是主要目标。
- 适配器面向 Chat Completions 风格上游，不是 OpenAI Responses API。
