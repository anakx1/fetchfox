#!/data/data/com.termux/files/usr/bin/bash
# Stop Fetchfox. aria2 is started with --stop-with-process, so it exits with the server.
set -u
pkill -f "node .*server\.mjs" 2>/dev/null
sleep 1
pkill -f "aria2c --conf-path.*fetchfox" 2>/dev/null
termux-wake-unlock 2>/dev/null || true
echo "Fetchfox stopped."
