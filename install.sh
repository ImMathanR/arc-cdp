#!/usr/bin/env bash
# Install the Arc CDP launch + self-heal LaunchAgents and helper scripts.
#
#   ARC_CDP_PORT   debug port (default 9223)
#   ARC_APP        path to Arc.app (default /Applications/Arc.app)
set -euo pipefail

PORT="${ARC_CDP_PORT:-9223}"
ARC_APP="${ARC_APP:-/Applications/Arc.app}"
ARC_BIN="$ARC_APP/Contents/MacOS/Arc"
BIN_DIR="$HOME/.local/bin"
LA_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENSURE="$BIN_DIR/arc-debug-ensure"
ERRLOG="$LOG_DIR/arc-debug-ensure.err.log"

[[ "$(uname)" == "Darwin" ]] || { echo "arc-cdp is macOS-only (launchd + Arc)."; exit 1; }
[[ -d "$ARC_APP" ]] || { echo "Arc not found at $ARC_APP. Re-run with ARC_APP=/path/to/Arc.app"; exit 1; }

mkdir -p "$BIN_DIR" "$LA_DIR" "$LOG_DIR"

echo "→ installing scripts to $BIN_DIR"
install -m 0755 "$REPO_DIR/bin/arc-debug"        "$BIN_DIR/arc-debug"
install -m 0755 "$REPO_DIR/bin/arc-debug-ensure" "$ENSURE"

echo "→ writing LaunchAgents to $LA_DIR"
render() {
  sed -e "s|__ARC_BIN__|$ARC_BIN|g" \
      -e "s|__PORT__|$PORT|g" \
      -e "s|__ENSURE__|$ENSURE|g" \
      -e "s|__ERRLOG__|$ERRLOG|g" "$1"
}
render "$REPO_DIR/launchagents/com.arc.debug-launch.plist" > "$LA_DIR/com.arc.debug-launch.plist"
render "$REPO_DIR/launchagents/com.arc.debug-heal.plist"   > "$LA_DIR/com.arc.debug-heal.plist"

echo "→ (re)loading LaunchAgents"
for label in com.arc.debug-launch com.arc.debug-heal; do
  launchctl unload "$LA_DIR/$label.plist" 2>/dev/null || true
  launchctl load  "$LA_DIR/$label.plist"
done

echo "→ ensuring Arc is up with --remote-debugging-port=$PORT"
"$ENSURE" login
sleep 2

echo
"$ENSURE" status
echo
echo "Done. Arc's CDP endpoint: http://127.0.0.1:$PORT/json/version"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "Note: add $BIN_DIR to your PATH to use 'arc-debug' / 'arc-debug-ensure' directly.";; esac
