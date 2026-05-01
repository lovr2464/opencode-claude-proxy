# OpenAI 到 Anthropic API 适配器

[English README](../README.md) | [Changelog](../CHANGELOG.md)

**买了 OpenCode Go 套餐但 Claude Code 不支持？** 这个本地适配器帮你打通。在 Claude Code 里用 Kimi、DeepSeek、GLM、Qwen 等模型。

代理只做三件事：

1. **协议翻译** — Anthropic Messages API ↔ OpenAI Chat Completions
2. **超时控制** — 上游请求超时（`proxy.requestTimeoutMs`）
3. **模型路由** — 哪个模型发到哪个上游端点

它**不设置**模型参数（temperature、max_tokens、上下文长度等）——这些从 Claude Code 原样透传。

## 运行环境

- **Node.js** ≥ 18
- **macOS** — 已测试，完全支持
- **Linux / Windows** — 未测试，可能能用（仅依赖 Node.js 标准库，无平台特定代码），但不保证

## 快速开始

```bash
chmod +x start.sh            # 仅首次需要
./start.sh                   # 首次运行：输入 API key → 自动创建 settings.json 并启动
./start.sh setup-claude      # 一次性：写入 3 个环境变量到 ~/.claude/settings.json
./start.sh install           # 可选：开机自启，挂了自动拉起
```

搞定。打开 Claude Code，从模型选择器里选模型。

所有命令：`./start.sh [start|stop|restart|status|install|uninstall|setup-claude]`

## 首次运行交互

`./start.sh` 会问 4 个问题，回车接受默认值（括号内的）：

```
OpenCode Go API key: sk-xxx
Upstream base URL [https://opencode.ai/zen/go/v1]: ↵
Models [kimi-k2.6 deepseek-v4-pro glm-5.1 qwen3.6-plus]: ↵
Listen port [8787]: ↵
```

自动生成 `settings.json` 并启动代理。

## setup-claude 做了什么

只往 `~/.claude/settings.json` 写入 3 个环境变量，不碰已有配置：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_API_KEY": "local-proxy-key",
    "ANTHROPIC_CUSTOM_MODEL_OPTION": "kimi-k2.6"
  }
}
```

## 切换模型

编辑 `~/.claude/settings.json`，改 `ANTHROPIC_CUSTOM_MODEL_OPTION` 为 `settings.json` 中 `model.openai.list` 里的任意模型名。也可加多个槽位快速切换：

```json
"ANTHROPIC_DEFAULT_SONNET_MODEL": "kimi-k2.6",
"ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-pro[1m]"
```

**DeepSeek V4 Pro 有 1M 上下文** — 加 `[1m]` 后缀让 Claude Code 显示正确的上下文窗口。代理发送前会自动去掉。

## Settings 配置说明

### proxy

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `host` | `127.0.0.1` | 监听地址 |
| `port` | `8787` | 监听端口 |
| `authMode` | `proxy` | `proxy` = key 在 settings.json。`passthrough` = key 来自 Claude Code |
| `requestTimeoutMs` | `300000` | 上游超时（毫秒） |
| `logLevel` | `info` | `info` 或 `silent` |

### upstream

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `baseUrl` | `https://opencode.ai/zen/go/v1` | 上游 API 地址 |
| `apiKey` | （你的 key） | OpenCode Go API key |

### model

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `openai.list` | `kimi-k2.6, deepseek-v4-pro, glm-5.1, qwen3.6-plus` | 模型名，原样透传到上游 |
| `openai.suffix_path` | `chat/completions` | 上游端点路径。Anthropic 原生模型请用 `anthropic` 组 |

## 适配其他供应商

默认配置针对 OpenCode Go（<https://opencode.ai/docs/zh-cn/go/>），截止 2026-04-30。如需更换供应商或模型列表，只改 `settings.json` 中三个字段：

| 字段 | 改什么 |
| --- | --- |
| `upstream.baseUrl` | 供应商的 API 基地址。请求发到 `${baseUrl}/${suffix_path}` |
| `model.openai.list` | 该供应商的模型 ID。原样透传到上游 |
| `model.openai.suffix_path` | 上游端点路径。默认 `chat/completions`。Anthropic 原生模型请改用 `anthropic` 组 |

示例 — 切换到假设的供应商：

```json
"upstream": { "baseUrl": "https://api.example.com/v1" },
"model": {
  "openai": { "list": ["their-model-v2"], "suffix_path": "chat/completions" }
}
```

其他不用动。代理不关心上游是谁，只要它说 OpenAI Chat Completions 协议。

## 手动配置 Claude Code / Claude Desktop

`./start.sh setup-claude` 可自动完成，但如果你想手动配：

### Claude Code CLI

在 `~/.claude/settings.json` 中添加：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_API_KEY": "local-proxy-key",
    "ANTHROPIC_CUSTOM_MODEL_OPTION": "kimi-k2.6"
  }
}
```

添加多个模型槽位快速切换：

```json
"ANTHROPIC_DEFAULT_SONNET_MODEL": "kimi-k2.6",
"ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-pro[1m]",
"ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-5.1"
```

### Claude Desktop（macOS 桌面应用）

按理来说 Claude Desktop 也能配，把类似`BASE_URL` 设为代理地址，API key 用占位符，添加模型条目。未实测——请自行验证。

### 注意

- `ANTHROPIC_API_KEY` 在 proxy 模式下填任意非空字符串——真实 key 在 `settings.json` 里。
- 模型名必须和 `settings.json` 中 `model.openai.list` 的条目一致。
- `[1m]` 后缀是 Claude Code 的上下文窗口显示提示，代理发送前自动去掉。
- 设置了多个 `DEFAULT_*_MODEL` 槽位后，在 Claude Code 里切换 Sonnet/Opus/Haiku 槽位即可切换模型。

## 故障排除

**上游 401/403。** `upstream.apiKey` 错误或过期。

**响应只有 thinking，没有文本。** 推理模型吃 token。增大 `max_tokens`，或在 settings.json 加 `"behavior": { "reasoningMode": "drop" }`。

**"model not found"。** 模型名不在 `model.openai.list` 里。跑 `./start.sh status` 查看。

**代理无响应。** 跑 `./start.sh status` 检查。重启：`./start.sh restart`。

## 开发

```bash
npm test        # 30 个测试，不需要 API key
npm run dev     # 文件变更自动重启
```

## License

MIT
