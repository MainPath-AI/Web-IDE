#!/bin/bash
set -o pipefail
mount -o remount,rw / >/dev/null 2>&1 || true
mkdir -p /var/log /root/.config/code-server /root/.local/share/code-server /tmp

echo "WEB_IDE_INIT 4 arch=$(uname -m)"
cat > /root/.config/code-server/config.yaml <<'CONFIG'
bind-addr: 0.0.0.0:8080
auth: none
cert: false
disable-telemetry: true
CONFIG

# Use the installed tools without running asdf's shell initialization. Keep
# asdf itself available when a user explicitly invokes it.
export PATH=/root/.asdf/installs/python/3.12.7/bin:/root/.asdf/installs/nodejs/20.19.5/bin:/root/.asdf/installs/hugo/0.168.0/bin:/root/.asdf/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# The process already has the complete tool environment. VS Code's supported
# CLI marker skips its additional interactive shell + Node environment probe,
# including the probes requested later by the extension and PTY hosts.
export VSCODE_CLI=1
printf '%s\n' \
  "export PATH=${PATH}" \
  'cd /opt/web-ide/demos' > /root/.bashrc
cp /root/.bashrc /root/.profile
cp /root/.bashrc /root/.bash_profile
mkdir -p /root/.local/share/code-server/User
cat > /root/.local/share/code-server/User/settings.json <<'SETTINGS'
{
  "workbench.startupEditor": "none",
  "chat.disableAIFeatures": true,
  "telemetry.telemetryLevel": "off",
  "extensions.autoCheckUpdates": false,
  "extensions.autoUpdate": false,
  "terminal.integrated.shellIntegration.enabled": false,
  "terminal.integrated.defaultProfile.linux": "bash",
  "terminal.integrated.profiles.linux": {
    "bash": { "path": "/bin/bash", "args": ["--noprofile", "--norc"] }
  }
}
SETTINGS

code_root="$(echo /opt/code-server-*-linux-amd64)"
entry="${code_root}/out/node/entry.js"
if [ -f "${entry}" ]; then
  # Preserve the existing single-process launcher while collecting startup
  # diagnostics. The stock launcher performs an additional IPC handshake.
  sed -i 's/return wrapper_1.wrapper.start(args);/return (0, main_1.runCodeServer)(args);/' "${entry}" || true
fi

log_file=/var/log/code-server.log
: > "${log_file}"
# Stream each line once, including logs after HTTP readiness. The file remains
# available to the serial shell; do not make shell startup wait for the reader.
tail -n +1 -F --sleep-interval=1 "${log_file}" | sed -u 's/^/WEB_IDE_CODE_SERVER_LOG /' &

if [ -x "${code_root}/lib/node" ]; then
  "${code_root}/lib/node" "${code_root}" \
    --auth none \
    --bind-addr 0.0.0.0:8080 \
    --disable-telemetry \
    --disable-update-check \
    --disable-workspace-trust \
    --log info \
    --user-data-dir /root/.local/share/code-server \
    /opt/web-ide/demos >"${log_file}" 2>&1 &
  code_server_pid=$!
  echo "WEB_IDE_CODE_SERVER_STARTING pid=${code_server_pid}"
else
  echo "WEB_IDE_CODE_SERVER_MISSING ${code_root}/lib/node"
fi

# Health checks must never own stdin or delay the foreground diagnostic shell.
# The native snapshot builder still waits for this marker from the background
# monitor, after a successful response from code-server inside the guest.
(
  for ((i=1; i<=900; i++)); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:8080/ || true)"
    case "${code}" in
      2[0-9][0-9]|3[0-9][0-9])
        echo "WEB_IDE_CODE_SERVER_HTTP ${code}"
        echo "WEB_IDE_SNAPSHOT"
        exit 0
        ;;
    esac
    echo "WEB_IDE_WAIT ${code:-000} attempt=${i}"
    sleep 2
  done
  echo "WEB_IDE_CODE_SERVER_HTTP_FAIL"
) </dev/null &

cd /opt/web-ide/demos || exit 1
export PS1='root@\h:\w# '
echo "WEB_IDE_READY arch=$(uname -m) shell=/bin/bash"
exec /bin/bash --noprofile --norc
