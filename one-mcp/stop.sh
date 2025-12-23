#!/usr/bin/env bash
set -euo pipefail

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
LOG_FILE="$DIR/one-mcp.log"
PID_FILE="$HOME/.config/1mcp/server.pid"

if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE" || true)"
  if [[ -n "${PID:-}" ]] && kill -0 "$PID" 2>/dev/null; then
    echo "Stopping 1MCP (PID $PID)..."
    kill "$PID" || true
    sleep 1
  else
    echo "No running 1MCP process found (PID file existed but process not running)."
  fi
  rm -f "$PID_FILE" || true
else
  echo "No PID file found at $PID_FILE"
fi

echo "Last logs (if any):"
if [[ -f "$LOG_FILE" ]]; then
  tail -n 30 "$LOG_FILE"
else
  echo "(no log file yet: $LOG_FILE)"
fi
