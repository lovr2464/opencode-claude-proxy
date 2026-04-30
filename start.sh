#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

echo ""
echo "  OpenAI-to-Anthropic API Adapter  v$(node -p "require('./package.json').version")"
echo "  ───────────────────────────────────────────────"

# Check Node.js version
node_version=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$node_version" -lt 18 ]; then
  echo -e "  ${RED}Error: Node.js 18+ required (found v$(node -v))${NC}"
  exit 1
fi

# Check settings exists.
if [ ! -f settings.json ]; then
  echo -e "  ${RED}Error: settings.json is required.${NC}"
  echo "  Create it from the README example, then set upstream.baseUrl, upstream.apiKey, and model ids."
  exit 1
fi

# Syntax check
if ! node --check server.js 2>/dev/null; then
  echo -e "  ${RED}Error: server.js has syntax errors${NC}"
  exit 1
fi

proxy_port=$(node -e "import { buildConfig, loadConfigSources } from './src/config.js'; console.log(buildConfig(loadConfigSources()).port)")

# Warn if port is already in use
if lsof -ti :"$proxy_port" >/dev/null 2>&1; then
  echo -e "  ${RED}Warning: port $proxy_port is in use. Kill existing process first:${NC}"
  echo "    kill -9 \$(lsof -ti :$proxy_port)"
  echo ""
fi

echo "  Starting proxy ..."
echo ""
exec node server.js
