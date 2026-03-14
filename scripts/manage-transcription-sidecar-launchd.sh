#!/usr/bin/env bash
set -euo pipefail

LABEL="com.soundcast.asr-sidecar"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
START_SCRIPT="$REPO_ROOT/scripts/start-transcription-sidecar.sh"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
STDOUT_PATH="/tmp/soundcast-asr.out.log"
STDERR_PATH="/tmp/soundcast-asr.err.log"
PYTHON_BIN_PATH="${PYTHON_BIN_PATH:-$(command -v python3 || true)}"

if [[ -z "$PYTHON_BIN_PATH" ]]; then
  echo "python3 not found in PATH. Set PYTHON_BIN_PATH and retry."
  exit 1
fi

usage() {
  cat <<EOF
Usage: $(basename "$0") <command>

Commands:
  install    Write plist and load launch agent (auto-start + auto-restart)
  uninstall  Unload launch agent and remove plist
  start      Start loaded launch agent
  stop       Stop loaded launch agent
  restart    Restart loaded launch agent
  status     Show launchctl status and sidecar listener state
  logs       Tail sidecar logs
  print      Print generated plist content

Env:
  PYTHON_BIN_PATH=/absolute/path/to/python3
EOF
}

require_start_script() {
  if [[ ! -x "$START_SCRIPT" ]]; then
    echo "Missing or non-executable start script: $START_SCRIPT"
    exit 1
  fi
}

write_plist() {
  mkdir -p "$(dirname "$PLIST_PATH")"
  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${START_SCRIPT}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${REPO_ROOT}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PYTHON_BIN</key>
      <string>${PYTHON_BIN_PATH}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>${STDOUT_PATH}</string>
    <key>StandardErrorPath</key>
    <string>${STDERR_PATH}</string>
  </dict>
</plist>
EOF
}

cmd="${1:-}"
case "$cmd" in
  install)
    require_start_script
    write_plist
    launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
    launchctl load "$PLIST_PATH"
    echo "Installed and loaded: $PLIST_PATH"
    echo "Python: $PYTHON_BIN_PATH"
    echo "Logs: $STDOUT_PATH | $STDERR_PATH"
    ;;
  uninstall)
    launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
    rm -f "$PLIST_PATH"
    echo "Uninstalled launch agent: $LABEL"
    ;;
  start)
    launchctl start "$LABEL"
    echo "Started: $LABEL"
    ;;
  stop)
    launchctl stop "$LABEL"
    echo "Stopped: $LABEL"
    ;;
  restart)
    launchctl stop "$LABEL" >/dev/null 2>&1 || true
    launchctl start "$LABEL"
    echo "Restarted: $LABEL"
    ;;
  status)
    if command -v rg >/dev/null 2>&1; then
      launchctl list | rg "$LABEL" || echo "No launchctl entry found for $LABEL"
    else
      launchctl list | grep -F "$LABEL" || echo "No launchctl entry found for $LABEL"
    fi
    # More detailed status (newer launchctl format)
    launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && launchctl print "gui/$(id -u)/$LABEL" | head -n 20 || true
    lsof -iTCP:8765 -sTCP:LISTEN -n -P || true
    ;;
  logs)
    touch "$STDOUT_PATH" "$STDERR_PATH"
    tail -f "$STDOUT_PATH" "$STDERR_PATH"
    ;;
  print)
    write_plist
    cat "$PLIST_PATH"
    ;;
  *)
    usage
    exit 1
    ;;
esac
