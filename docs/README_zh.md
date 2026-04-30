# OpenAI 到 Anthropic API 适配器

[English README](../README.md) | [设计文档](design_zh.md) | [Design](design.md)

这是一个本地适配器：向 Claude Code 暴露 Anthropic Messages API，向上游调用 OpenAI 兼容的 Chat Completions 接口。

有些服务商只提供 OpenAI 兼容接口，但模型本身很适合在 Claude Code 中使用。例如 OpenCode Go 可能通过 OpenAI 风格接口提供 Kimi、DeepSeek、Qwen 等模型；这时就需要这个适配器把 Claude Code 的 Anthropic API 请求和响应转换过去。

## 快速开始

1. 编辑 `settings.json`。

发布到 GitHub 时，仓库里的 `settings.json` 应保持模板状态，不要提交真实上游 API key。

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

2. 启动适配器。

```bash
./start.sh
```

也可以直接启动：

```bash
node server.js
```

默认监听 `http://127.0.0.1:8787`。

## 配置 Claude Code

在 Claude Code 自己的 settings 文件里指向本地适配器。API key 用占位值即可，模型名必须和本项目 `settings.json` 里的 `model.claudeId` 一致。

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_API_KEY": "opencode-go-local",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "opencode-go",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "opencode-go",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "opencode-go",
    "CLAUDE_CODE_SUBAGENT_MODEL": "opencode-go",
    "ANTHROPIC_CUSTOM_MODEL_OPTION": "opencode-go",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": "OpenAI-compatible model via local adapter",
    "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION": "Anthropic Messages API backed by an OpenAI-compatible endpoint"
  }
}
```

推荐使用 `proxy.authMode: "proxy"`：Claude Code 只看到 `opencode-go-local`，真实上游 key 留在本项目的 `settings.json` 里。

## settings 配置说明

| 配置项 | 含义 |
| --- | --- |
| `proxy.host` | 本地监听 host。只给本机使用时保持 `127.0.0.1`。 |
| `proxy.port` | 本地监听端口。Claude Code 的 `ANTHROPIC_BASE_URL` 必须使用这个端口。 |
| `proxy.authMode` | `proxy` 表示真实上游 key 写在 `settings.json`；`passthrough` 表示转发 Claude Code 的 `ANTHROPIC_API_KEY`。 |
| `proxy.requestTimeoutMs` | 上游请求超时时间，单位毫秒。 |
| `proxy.logLevel` | `info` 输出启动和错误日志；`silent` 减少日志。 |
| `upstream.baseUrl` | OpenAI 兼容 API base URL。适配器会调用 `${baseUrl}/chat/completions`。 |
| `upstream.apiKey` | `authMode` 为 `proxy` 时使用的真实上游 API key。 |
| `model.claudeId` | Claude Code 使用的占位模型 id。 |
| `model.upstreamId` | 真实上游模型 id，作为默认映射目标。 |
| `model.list` | `/v1/models` 返回给 Claude Code 的模型列表，通常只放占位模型名。 |
| `model.map` | 把 Claude Code 侧模型名映射到真实上游模型名。 |

默认协议行为针对 Claude Code 做了取舍：

- Anthropic `tool_choice: any` 和 `tool_choice: tool` 会降级为 OpenAI `tool_choice: auto`，避免部分推理模型拒绝强制工具调用。
- Anthropic thinking 块和 OpenAI `reasoning_content` / `reasoning` 字段会双向转换。
- 流式 SSE 事件会转换成 Anthropic Messages API 的事件顺序。

## 接口

| 接口 | 方法 | 描述 |
| --- | --- | --- |
| `/v1/messages` | POST | Anthropic Messages 兼容聊天接口，支持流式和非流式。 |
| `/v1/models` | GET | 基于 `model.list` 返回 Anthropic 格式模型列表。 |
| `/health` | GET | 健康检查，返回不含 secret 的配置摘要。 |

## 开发

```bash
npm run check
npm test
npm run dev
npm run doctor
```

测试使用本地 mock 上游，不需要 API key。

## 设计文档

架构、协议映射、流式转换和限制见 [docs/design_zh.md](design_zh.md)。英文版见 [docs/design.md](design.md)。

## License

MIT
