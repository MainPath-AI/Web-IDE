#!/bin/bash
set -euo pipefail
mkdir -p "$HOME/project" "$HOME/.local/share/code-server/User" "$HOME/.config/code-server"
if [[ ! -f "$HOME/project/README.md" ]]; then
  cp -a /opt/web-ide-seed/. "$HOME/project/"
fi
cat > "$HOME/.local/share/code-server/User/settings.json" << 'EOF'
{
  "security.workspace.trust.enabled": false,
  "terminal.integrated.defaultProfile.linux": "bash",
  "workbench.startupEditor": "none"
}
EOF
exec code-server \
  --auth none \
  --bind-addr 0.0.0.0:8080 \
  --disable-telemetry \
  --disable-update-check \
  --disable-workspace-trust \
  --user-data-dir "$HOME/.local/share/code-server" \
  "$HOME/project"
