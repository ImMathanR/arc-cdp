#!/usr/bin/env bash
# Remove the Arc CDP LaunchAgents and helper scripts.
set -euo pipefail

LA_DIR="$HOME/Library/LaunchAgents"
BIN_DIR="$HOME/.local/bin"

for label in com.arc.debug-launch com.arc.debug-heal; do
  launchctl unload "$LA_DIR/$label.plist" 2>/dev/null || true
  rm -f "$LA_DIR/$label.plist"
done
rm -f "$BIN_DIR/arc-debug" "$BIN_DIR/arc-debug-ensure"

echo "Uninstalled. Arc keeps running with the debug flag until you quit + reopen it normally."
