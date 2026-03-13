#!/bin/bash
# Start credvault server
cd /home/node/.openclaw/workspace/scripts/credvault
node server.js >> /tmp/credvault.log 2>&1 &
echo $! > /tmp/credvault.pid
echo "Credvault started on port 18795 (PID: $(cat /tmp/credvault.pid))"
