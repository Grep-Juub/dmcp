#!/bin/bash

PID=$(pgrep -f "agentgateway -f")
if [ -n "$PID" ]; then
  echo "Stopping agentgateway (PID: $PID)..."
  kill $PID
else
  echo "agentgateway is not running."
fi
