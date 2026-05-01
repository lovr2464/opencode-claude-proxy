# OpenAI 到 Anthropic API 适配器

[English README](../README.md) | [Changelog](../CHANGELOG.md)

**买了 OpenCode Go 套餐但 Claude Code 不支持？** 这个本地适配器帮你打通。它架在 Claude Code 和 OpenAI 兼容 API 之间，实时翻译 Anthropic↔OpenAI 协议。在 Claude Code 里用 Kimi、DeepSeek、GLM、Qwen 等模型。

## 快速开始

```bash
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
