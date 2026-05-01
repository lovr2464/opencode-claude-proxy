# OpenAI 到 Anthropic API 适配器

[English README](../README.md) | [Changelog](../CHANGELOG.md)

这是一个本地适配器：向 Claude Code 暴露 Anthropic Messages API，向上游调用 OpenAI 兼容的 Chat Completions 接口。用于在 Claude Code 中使用 Kimi、DeepSeek、Qwen 等通过 OpenCode Go（或类似服务商）提供的模型。

## 快速开始

**1. 创建配置文件。**

```bash
cp settings.example.json settings.json
```

编辑 `settings.json`——只需要改 `upstream.apiKey` 和模型映射：

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
    "apiKey": "你的API key"
  },
  "model": {
    "map": {
      "opencode-go": "kimi-k2.6",
      "*": "kimi-k2.6"
    }
  }
}
```

`model.map` 是唯一的模型配置。键 = Claude Code 侧模型名，值 = 上游真实模型名。第一个键为默认模型。`"*"` 是通配符——任何未映射的模型名（包括 Claude Code 的 Opus/Haiku/Subagent 默认值）都会被路由到你的上游模型。

**2. 启动适配器。**

```bash
./start.sh
```

`start.sh` 会检查配置、显示模型映射，并输出 Claude Code 所需的配置片段。默认监听 `http://127.0.0.1:8787`。

**3. 配置 Claude Code。**

`start.sh` 会自动打印这段配置，手动版如下。添加到 Claude Code 的 settings 文件中：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_API_KEY": "opencode-go-local",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "opencode-go",
    "ANTHROPIC_CUSTOM_MODEL_OPTION": "opencode-go"
  }
}
```

模型名（`opencode-go`）必须和 `model.map` 中的某个键一致。`authMode` 为 `proxy` 时，API key 可填任意占位值——真实 key 留在 `settings.json` 里。

四项为最小配置。`model.map` 中的 `"*"` 通配符会自动兜住其他模型槽位（Opus、Haiku、Subagent），无需逐个设置。

**4. 验证。**

```bash
# 健康检查
curl -s http://127.0.0.1:8787/health | python3 -m json.tool

# 快速消息测试（注意推理模型需要足够的 max_tokens）
curl -s http://127.0.0.1:8787/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: opencode-go-local" \
  -d '{"model":"opencode-go","max_tokens":100,"messages":[{"role":"user","content":"回复OK"}]}' \
  | python3 -m json.tool

# Claude Code CLI 端到端测试
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 \
ANTHROPIC_API_KEY=opencode-go-local \
ANTHROPIC_DEFAULT_SONNET_MODEL=opencode-go \
claude -p "say hello" --max-turns 1
```

## Settings 配置说明

### proxy

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `host` | `127.0.0.1` | 监听地址。仅本机使用保持 `127.0.0.1`。 |
| `port` | `8787` | 监听端口。必须和 `ANTHROPIC_BASE_URL` 一致。 |
| `authMode` | `proxy` | `proxy`——真实 key 在 `settings.json`。`passthrough`——转发 Claude Code 的 key。 |
| `requestTimeoutMs` | `300000` | 上游请求超时（毫秒）。 |
| `logLevel` | `info` | `info` 输出请求和错误日志；`silent` 不输出。 |

### upstream

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `baseUrl` | （必填） | OpenAI 兼容 API base URL。请求发往 `${baseUrl}/chat/completions`。 |
| `apiKey` | （proxy 模式必填） | 真实上游 API key。 |

### model

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `map` | （必填） | 模型 ID 映射。键 = Claude Code 侧，值 = 上游侧。键列表即 `/v1/models` 返回值。 |
| `default` | `map` 的第一个键 | 指定默认模型，必须是 `map` 中的某个键。 |

多模型示例：

```json
"model": {
  "default": "deepseek",
  "map": {
    "opencode-go": "kimi-k2.6",
    "deepseek": "deepseek-v3",
    "*": "kimi-k2.6"
  }
}
```

### behavior（可选）

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `toolChoicePolicy` | `auto-on-forced` | 强制工具选择策略。`auto-on-forced` 将 `any`/`tool` 降级为 `auto`。`drop` 完全移除。 |
| `reasoningMode` | `auto` | `auto` 双向转换 reasoning。`drop` 丢弃所有 reasoning/thinking 块。 |

## 接口

| 接口 | 方法 | 描述 |
| --- | --- | --- |
| `/v1/messages` | POST | Anthropic Messages 兼容聊天接口，支持流式和非流式。 |
| `/v1/models` | GET | 返回 `model.map` 的键作为模型列表。 |
| `/health` | GET | 健康检查，返回不含 secret 的配置摘要。 |

## 故障排除

**上游返回 401/403。**
`upstream.apiKey` 错误或过期。检查 `settings.json`。

**响应只有 thinking/reasoning 内容，没有文本回复。**
推理模型（Kimi K2.6、DeepSeek-R1 等）的 thinking token 计入 `max_tokens`。如果回复被截断，增大 `max_tokens`，或在 settings.json 中设置 `behavior.reasoningMode` 为 `"drop"` 来完全跳过 thinking 块。

**Claude Code 提示 "model not found" 或回退到 Anthropic 模型。**
`model.map` 的键和 Claude Code 请求的模型名不匹配。查看 `start.sh` 输出的正确模型名，或添加 `"*"` 通配符。

**启动时报 "Port already in use"。**
先杀掉已有进程：`kill -9 $(lsof -ti :8787)`

**上游超时。**
如果上游模型响应慢，增大 `proxy.requestTimeoutMs`。默认 5 分钟。

## 开发

```bash
npm run check
npm test
npm run dev
npm run doctor
```

测试使用本地 mock 上游，不需要 API key。

## License

MIT

MIT
