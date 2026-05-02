#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

PID_FILE=".proxy.pid"
LOG_FILE="proxy.log"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

CMD="${1:-start}"

# ── Helpers ───────────────────────────────────────────────────────────────────

read_config() {
  node -e "import { buildConfig, loadConfigSources } from './src/config.js'; const c = buildConfig(loadConfigSources()); console.log(JSON.stringify({host:c.host,port:c.port,authMode:c.authMode,upstreamBaseUrl:c.upstreamBaseUrl,apiKey:c.apiKey,defaultModel:c.defaultModel,models:c.models,groups:c.groups}))" 2>&1
}

# ── Daemon commands ───────────────────────────────────────────────────────────

if [ "$CMD" = "stop" ]; then
  STOPPED=0
  PLIST="$HOME/Library/LaunchAgents/com.opencode.anthropic-proxy.plist"
  LAUNCHD_ACTIVE=0

  # Check if managed by LaunchAgent
  if [ -f "$PLIST" ] && launchctl list 2>/dev/null | awk '{print $3}' | grep -q "^com.opencode.anthropic-proxy$"; then
    LAUNCHD_ACTIVE=1
    launchctl unload "$PLIST" 2>/dev/null
    echo -e "  ${GREEN}LaunchAgent unloaded${NC}"
  fi

  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID" 2>/dev/null
      for i in 1 2 3; do
        if ! kill -0 "$PID" 2>/dev/null; then break; fi
        sleep 1
      done
      if kill -0 "$PID" 2>/dev/null; then
        kill -9 "$PID" 2>/dev/null
        sleep 1
      fi
      echo -e "  ${GREEN}Proxy stopped (PID $PID)${NC}"
      STOPPED=1
    fi
    rm -f "$PID_FILE"
  fi

  # Fallback: kill by port if PID file missing or stale
  RPORT=$(node -e "import { buildConfig, loadConfigSources } from './src/config.js'; console.log(buildConfig(loadConfigSources()).port)" 2>/dev/null || echo 8787)
  ORPHAN_PID=$(lsof -ti :"$RPORT" 2>/dev/null)
  if [ -n "$ORPHAN_PID" ]; then
    CMDLINE=$(ps -p "$ORPHAN_PID" -o args= 2>/dev/null || echo "")
    if echo "$CMDLINE" | grep -q "server.js"; then
      kill -9 "$ORPHAN_PID" 2>/dev/null
      echo -e "  ${GREEN}Proxy stopped (orphan PID $ORPHAN_PID)${NC}"
      STOPPED=1
    fi
  fi

  if [ "$STOPPED" -eq 0 ]; then
    echo -e "  ${YELLOW}Proxy not running${NC}"
  fi

  if [ "$LAUNCHD_ACTIVE" -eq 1 ]; then
    echo -e "  ${YELLOW}LaunchAgent removed — proxy will not auto-restart on login.${NC}"
  fi
  exit 0
fi

if [ "$CMD" = "status" ]; then
  LAUNCHD_ACTIVE=0
  if launchctl list 2>/dev/null | grep -q "com.opencode.anthropic-proxy"; then
    LAUNCHD_ACTIVE=1
  fi

  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
      echo -e "  ${GREEN}Proxy running (PID $PID)${NC}"
      if [ "$LAUNCHD_ACTIVE" -eq 1 ]; then
        echo -e "  ${CYAN}Managed by LaunchAgent (auto-restart on login)${NC}"
      fi
      HEALTH=$(curl -s "http://127.0.0.1:${PORT:-8787}/health" 2>/dev/null)
      if [ -n "$HEALTH" ]; then
        UPTIME=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); u=d.get('uptime_seconds',0); print(f'{u//3600}h {(u%3600)//60}m {u%60}s')" 2>/dev/null)
        LAST=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); l=d.get('last_request_seconds_ago'); print(f'{l}s ago') if l is not None else print('never')" 2>/dev/null)
        MODELS=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(', '.join(d.get('models',[])))" 2>/dev/null)
        echo "  Uptime: $UPTIME"
        echo "  Last request: $LAST"
        echo "  Models: $MODELS"
      fi
      echo "  Log: tail -f $LOG_FILE"
      exit 0
    else
      rm -f "$PID_FILE"
      echo -e "  ${YELLOW}Stale PID file removed${NC}"
    fi
  fi

  # Check for orphan process (no PID file but port in use)
  RPORT=$(node -e "import { buildConfig, loadConfigSources } from './src/config.js'; console.log(buildConfig(loadConfigSources()).port)" 2>/dev/null || echo 8787)
  ORPHAN_PID=$(lsof -ti :"$RPORT" 2>/dev/null)
  if [ -n "$ORPHAN_PID" ]; then
    CMDLINE=$(ps -p "$ORPHAN_PID" -o args= 2>/dev/null || echo "")
    if echo "$CMDLINE" | grep -q "server.js"; then
      echo -e "  ${YELLOW}Proxy running (orphan PID $ORPHAN_PID, no PID file)${NC}"
      if [ "$LAUNCHD_ACTIVE" -eq 1 ]; then
        echo -e "  ${CYAN}Managed by LaunchAgent (auto-restart on login)${NC}"
      fi
      echo "  ./start.sh stop     — stop and clean up"
      echo "  Log: tail -f $LOG_FILE"
      exit 0
    fi
  fi

  if [ "$LAUNCHD_ACTIVE" -eq 1 ]; then
    echo -e "  ${YELLOW}LaunchAgent installed but proxy is not currently running${NC}"
    echo "  It will auto-start on next login."
    exit 0
  fi

  echo -e "  ${YELLOW}Proxy not running${NC}"
  exit 0
fi

if [ "$CMD" = "restart" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.opencode.anthropic-proxy.plist"
  LAUNCHD_ACTIVE=0
  if [ -f "$PLIST" ] && launchctl list 2>/dev/null | awk '{print $3}' | grep -q "^com.opencode.anthropic-proxy$"; then
    LAUNCHD_ACTIVE=1
    launchctl unload "$PLIST" 2>/dev/null
  fi

  "$0" stop

  # Read port from settings
  RPORT=$(node -e "import { buildConfig, loadConfigSources } from './src/config.js'; console.log(buildConfig(loadConfigSources()).port)" 2>/dev/null || echo 8787)
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if ! lsof -ti :"$RPORT" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  if lsof -ti :"$RPORT" >/dev/null 2>&1; then
    echo -e "  ${RED}Error: Port $RPORT is still in use after 10s. Force killing...${NC}"
    kill -9 $(lsof -ti :"$RPORT") 2>/dev/null || true
    sleep 2
  fi

  if [ "$LAUNCHD_ACTIVE" -eq 1 ]; then
    launchctl load "$PLIST"
    echo -e "  ${GREEN}Proxy restarted via LaunchAgent${NC}"
    exit 0
  fi
  exec "$0" start
fi

if [ "$CMD" = "install" ]; then
  if ! node --check server.js 2>/dev/null; then
    echo -e "  ${RED}Error: server.js has syntax errors. Fix before installing.${NC}"
    exit 1
  fi

  PLIST="com.opencode.anthropic-proxy.plist"
  PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST"
  PROXY_DIR="$(pwd)"
  NODE_PATH="$(which node)"

  mkdir -p "$HOME/Library/LaunchAgents"

  cat > "$PLIST_PATH" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.opencode.anthropic-proxy</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$PROXY_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$PROXY_DIR/proxy.log</string>
    <key>StandardErrorPath</key>
    <string>$PROXY_DIR/proxy.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
PLISTEOF

  launchctl unload "$PLIST_PATH" 2>/dev/null
  launchctl load "$PLIST_PATH"
  echo -e "  ${GREEN}Installed and started.${NC}"
  echo "  Proxy will auto-start on login and restart if it crashes."
  echo "  Check status: ./start.sh status"
  echo "  Uninstall:    ./start.sh uninstall"
  exit 0
fi

if [ "$CMD" = "uninstall" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.opencode.anthropic-proxy.plist"
  if [ -f "$PLIST" ]; then
    launchctl unload "$PLIST" 2>/dev/null
    rm -f "$PLIST"
    "$0" stop 2>/dev/null
    echo -e "  ${GREEN}Uninstalled.${NC}"
  else
    echo -e "  ${YELLOW}Not installed.${NC}"
  fi
  exit 0
fi

if [ "$CMD" = "setup-claude" ]; then
  CLAUDE_SETTINGS="$HOME/.claude/settings.json"

  if [ ! -f "$CLAUDE_SETTINGS" ]; then
    echo -e "  ${RED}Claude Code settings not found at $CLAUDE_SETTINGS${NC}"
    echo "  This proxy requires Claude Code. Install it first:"
    echo "    https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview"
    echo ""
    echo "  Then configure manually by adding to $CLAUDE_SETTINGS:"
    echo '    {"env": {"ANTHROPIC_BASE_URL": "http://127.0.0.1:<port>", "ANTHROPIC_API_KEY": "local-proxy-key"}}'
    exit 1
  fi

  CONFIG_JSON=$(read_config)
  DEFAULT_MODEL=$(echo "$CONFIG_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['defaultModel'])")
  HOST=$(echo "$CONFIG_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['host'])")
  PORT=$(echo "$CONFIG_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['port'])")
  AUTH_MODE=$(echo "$CONFIG_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['authMode'])")

  if [ -f "$CLAUDE_SETTINGS" ]; then
    EXISTING=$(cat "$CLAUDE_SETTINGS")
  else
    EXISTING="{}"
  fi

  echo "$EXISTING" | python3 -c "
import sys, json
config = json.load(sys.stdin)
if 'env' not in config:
    config['env'] = {}
# Only set these three — never touch existing config
config['env']['ANTHROPIC_BASE_URL'] = 'http://$HOST:$PORT'
config['env']['ANTHROPIC_API_KEY'] = 'local-proxy-key' if '$AUTH_MODE' == 'proxy' else '<your-api-key>'
config['env']['ANTHROPIC_CUSTOM_MODEL_OPTION'] = '$DEFAULT_MODEL'
with open('$CLAUDE_SETTINGS', 'w') as f:
    json.dump(config, f, indent=2, ensure_ascii=False)
    f.write('\n')
print('done')
" && echo -e "  ${GREEN}Claude Code configured at $CLAUDE_SETTINGS${NC}" || echo -e "  ${RED}Failed${NC}"
  echo ""
  echo "  Only 3 env vars were added (existing config preserved):"
  echo "    ANTHROPIC_BASE_URL = http://$HOST:$PORT"
  echo "    ANTHROPIC_API_KEY = local-proxy-key"
  echo "    ANTHROPIC_CUSTOM_MODEL_OPTION = $DEFAULT_MODEL"
  echo ""
  echo "  Switch models: change CUSTOM_MODEL_OPTION in $CLAUDE_SETTINGS."
  echo "  For large-context models, add suffix: deepseek-v4-pro[1m]"
  exit 0
fi

if [ "$CMD" != "start" ]; then
  echo "Usage: ./start.sh [start|stop|restart|status|install|uninstall|setup-claude]"
  exit 1
fi

VERSION=$(node -p "require('./package.json').version")

echo ""
echo -e "  ${CYAN}OpenAI-to-Anthropic API Adapter${NC}  v${VERSION}"
echo "  ───────────────────────────────────────────────"

# ── Node.js version ──────────────────────────────────────────────────────────

node_version=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$node_version" -lt 18 ]; then
  echo ""
  echo -e "  ${RED}Error: Node.js 18+ required (found v$(node -v))${NC}"
  exit 1
fi

# ── Settings file ────────────────────────────────────────────────────────────

if [ ! -f settings.json ]; then
  echo ""
  echo -e "  ${YELLOW}First run — let's create settings.json${NC}"
  echo "  ───────────────────────────────────────────────"
  echo ""

  # API key
  read -p "  OpenCode Go API key: " API_KEY_INPUT
  if [ -z "$API_KEY_INPUT" ]; then
    echo ""
    echo -e "  ${RED}API key is required.${NC} Get it from https://opencode.ai/workspace"
    exit 1
  fi

  # Base URL
  read -p "  Upstream base URL [https://opencode.ai/zen/go/v1]: " BASE_URL_INPUT
  BASE_URL_INPUT=${BASE_URL_INPUT:-https://opencode.ai/zen/go/v1}

  # Models
  echo ""
  echo -e "  ${CYAN}Which models? (space-separated, or press Enter for defaults)${NC}"
  echo "  Common: kimi-k2.6 deepseek-v4-pro glm-5.1 qwen3.6-plus"
  read -p "  Models [kimi-k2.6 deepseek-v4-pro glm-5.1 qwen3.6-plus]: " MODELS_INPUT
  MODELS_INPUT=${MODELS_INPUT:-"kimi-k2.6 deepseek-v4-pro glm-5.1 qwen3.6-plus"}

  # Port
  read -p "  Listen port [8787]: " PORT_INPUT
  PORT_INPUT=${PORT_INPUT:-8787}

  PROXY_API_KEY="$API_KEY_INPUT" \
  PROXY_BASE_URL="$BASE_URL_INPUT" \
  PROXY_MODELS="$MODELS_INPUT" \
  PROXY_PORT="$PORT_INPUT" \
  python3 -c "
import os, json
config = {
    'proxy': {
        'host': '127.0.0.1',
        'port': int(os.environ['PROXY_PORT']),
        'authMode': 'proxy',
        'requestTimeoutMs': 300000,
        'logLevel': 'info'
    },
    'upstream': {
        'baseUrl': os.environ['PROXY_BASE_URL'],
        'apiKey': os.environ['PROXY_API_KEY']
    },
    'model': {
        'openai': {
            'list': os.environ['PROXY_MODELS'].strip().split(),
            'suffix_path': 'chat/completions'
        }
    }
}
with open('settings.json', 'w') as f:
    json.dump(config, f, indent=2, ensure_ascii=False)
    f.write('\n')
print('settings.json created')
" && echo "" || { echo -e "  ${RED}Failed to create settings.json${NC}"; exit 1; }
fi

# ── Syntax check ─────────────────────────────────────────────────────────────

if ! node --check server.js 2>/dev/null; then
  echo ""
  echo -e "  ${RED}Error: server.js has syntax errors${NC}"
  exit 1
fi

CONFIG_JSON=$(read_config)
if [ $? -ne 0 ]; then
  echo ""
  echo -e "  ${RED}Error: Failed to read settings.json${NC}"
  echo "  $CONFIG_JSON"
  exit 1
fi

HOST=$(echo "$CONFIG_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['host'])")
PORT=$(echo "$CONFIG_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['port'])")
AUTH_MODE=$(echo "$CONFIG_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['authMode'])")
TARGET=$(echo "$CONFIG_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['upstreamBaseUrl'])")
API_KEY=$(echo "$CONFIG_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['apiKey'])")
DEFAULT_MODEL=$(echo "$CONFIG_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['defaultModel'])")
GROUPS_JSON=$(echo "$CONFIG_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin)['groups']; print(json.dumps(d))")

echo ""
echo -e "  Proxy   : ${GREEN}http://${HOST}:${PORT}${NC}"
echo -e "  Target  : ${TARGET}"
echo -e "  Auth    : ${AUTH_MODE}"

# ── Model display ─────────────────────────────────────────────────────────────

echo "  Models  :"
echo "$GROUPS_JSON" | python3 -c "
import sys, json
groups = json.load(sys.stdin)
for g in groups:
    tag = 'convert' if g['type'] == 'openai' else 'passthrough'
    for m in g['list']:
        print(f'             {m}  ({tag})')
" 2>/dev/null || echo "             $DEFAULT_MODEL"

# ── API key check ────────────────────────────────────────────────────────────

if [ "$API_KEY" = "your-api-key" ] || [ -z "$API_KEY" ]; then
  echo ""
  echo -e "  ${RED}Warning: upstream.apiKey is still the placeholder value.${NC}"
  echo "  Edit settings.json and set your real API key, then restart."
  if [ "$AUTH_MODE" = "proxy" ]; then
    echo "  The proxy will start but upstream requests will fail with 401/403."
  fi
  echo ""
fi

# ── Port check ───────────────────────────────────────────────────────────────

if lsof -ti :"$PORT" >/dev/null 2>&1; then
  OCCUPANT_PID=$(lsof -ti :"$PORT" 2>/dev/null)
  CMDLINE=$(ps -p "$OCCUPANT_PID" -o args= 2>/dev/null || echo "")
  if echo "$CMDLINE" | grep -q "server.js"; then
    echo ""
    echo -e "  ${GREEN}Proxy already running on port $PORT (PID $OCCUPANT_PID)${NC}"
    echo "$OCCUPANT_PID" > "$PID_FILE"
    echo "  PID file recovered."
    echo "  ./start.sh status   — check details"
    echo "  ./start.sh restart  — restart"
    echo "  ./start.sh stop     — stop"
    exit 0
  else
    echo ""
    echo -e "  ${RED}Error: Port $PORT is occupied by another process (PID $OCCUPANT_PID)${NC}"
    echo "  $CMDLINE"
    exit 1
  fi
fi

# ── Claude Code config hint ──────────────────────────────────────────────────

echo ""
echo -e "  ${CYAN}Claude Code (or run: ./start.sh setup-claude):${NC}"
echo "    {"
echo "      \"env\": {"
echo "        \"ANTHROPIC_BASE_URL\": \"http://${HOST}:${PORT}\","
if [ "$AUTH_MODE" = "proxy" ]; then
  echo "        \"ANTHROPIC_API_KEY\": \"local-proxy-key\","
else
  echo "        \"ANTHROPIC_API_KEY\": \"<your-api-key>\","
fi
echo "        \"ANTHROPIC_CUSTOM_MODEL_OPTION\": \"${DEFAULT_MODEL}\""
echo "      }"
echo "    }"
echo ""

echo "  Starting ..."
echo ""
# Redirect stdout/stderr to proxy.log so console.log/debug output is visible
nohup node server.js >> "$LOG_FILE" 2>&1 &
PID=$!
echo "$PID" > "$PID_FILE"
echo -e "  ${GREEN}Proxy started (PID $PID)${NC}"
echo "  Log:  tail -f $LOG_FILE"
echo "  Stop: ./start.sh stop"
