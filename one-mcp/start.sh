#!/usr/bin/env bash
set -euo pipefail

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$(cd "$DIR/.." && pwd)"
CONFIG_FILE="$ROOT_DIR/one-mcp/mcp.json"
LOG_FILE="$DIR/one-mcp.log"
PID_FILE="$HOME/.config/1mcp/server.pid"

# Runs 1MCP as an HTTP server exposing:
# - /mcp (streamable HTTP)
# - /sse + /messages (SSE)
# This aggregates the per-backend agentgateway listeners.

if [[ -f "$PID_FILE" ]]; then
	OLD_PID="$(cat "$PID_FILE" || true)"
	if [[ -n "${OLD_PID:-}" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
		echo "Stopping existing 1MCP (PID $OLD_PID)..."
		kill "$OLD_PID" || true
		sleep 1
	fi
fi

echo "Starting 1MCP..."
echo "Logs will be written to $LOG_FILE"

nohup npx -y @1mcp/agent serve \
	--transport http \
	--port 3001 \
	--config "$CONFIG_FILE" \
	--enable-async-loading \
	--async-min-servers 1 \
	--async-timeout 5000 \
	> "$LOG_FILE" 2>&1 &

echo "1MCP started with PID: $!"
