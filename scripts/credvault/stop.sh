#!/bin/bash
if [ -f /tmp/credvault.pid ]; then
  kill $(cat /tmp/credvault.pid) 2>/dev/null && echo "Credvault stopped" || echo "Already stopped"
  rm -f /tmp/credvault.pid
else
  echo "No PID file found"
fi
