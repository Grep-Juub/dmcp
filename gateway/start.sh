#!/bin/bash

# Get the directory of the script
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
LOG_FILE="$DIR/gateway.log"
BINARY="$DIR/agentgateway"
CONFIG="$DIR/config.yaml"
CONFIG_PARTS_DIR="$DIR/config_parts"

# Consolidate config parts
if [ -d "$CONFIG_PARTS_DIR" ]; then
  echo "Consolidating config parts from $CONFIG_PARTS_DIR..."
  # Ensure header is first, then others sorted
  cat "$CONFIG_PARTS_DIR"/00-header.yaml > "$CONFIG"
  # Concatenate all other yaml files, excluding 00-header.yaml
  find "$CONFIG_PARTS_DIR" -name "*.yaml" ! -name "00-header.yaml" | sort | xargs cat >> "$CONFIG"
else
  echo "Warning: Config parts directory not found at $CONFIG_PARTS_DIR"
fi

# Load secrets/config (optional). This file should not be committed.
ENV_FILE="$DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

# Check if agentgateway is already running
PID=$(pgrep -f "agentgateway -f")
if [ -n "$PID" ]; then
  echo "Stopping existing agentgateway (PID: $PID)..."
  kill $PID
  sleep 2
fi

echo "Starting agentgateway..."
echo "Logs will be written to $LOG_FILE"

# Run in background
nohup "$BINARY" -f "$CONFIG" > "$LOG_FILE" 2>&1 &
NEW_PID=$!

echo "agentgateway started with PID: $NEW_PID"
echo "To view logs, run: tail -f $LOG_FILE"
