#!/data/data/com.termux/files/usr/bin/bash
# Start the Fetchfox download manager (engine + web UI) in the background.
set -u
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-8080}"

# keep Android from freezing the transfer when the screen locks
termux-wake-lock 2>/dev/null || true

if curl -s -m 1 "http://127.0.0.1:${PORT}/api/state" >/dev/null 2>&1; then
  echo "Fetchfox is already running."
else
  nohup node server.mjs >> fetchfox.log 2>&1 &
  for _ in $(seq 1 20); do
    sleep 0.5
    if curl -s -m 1 "http://127.0.0.1:${PORT}/api/state" >/dev/null 2>&1; then break; fi
  done
fi

if curl -s -m 1 "http://127.0.0.1:${PORT}/api/state" >/dev/null 2>&1; then
  DIR_NOTE=$(grep -o 'saving to .*' fetchfox.log 2>/dev/null | tail -n 1 | sed 's/^saving to //')
  echo "  Fetchfox running  ->  http://127.0.0.1:${PORT}"
  echo "  downloads     ->  ${DIR_NOTE:-$HOME/storage/shared/Downloads/Fetchfox}"
  case "${1:-}" in
    open|--open|-o) termux-open-url "http://127.0.0.1:${PORT}" ;;
  esac
else
  echo "Failed to start. Last log lines:" >&2
  tail -n 20 fetchfox.log >&2
  exit 1
fi
