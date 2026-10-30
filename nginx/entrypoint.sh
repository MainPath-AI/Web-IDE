#!/bin/sh
set -eu
/usr/local/bin/web-ide-bridge -listen 127.0.0.1:8888 &
bridge_pid=$!
nginx -g "daemon off;" &
nginx_pid=$!
shutdown() {
    trap - EXIT TERM INT QUIT
    kill -TERM "$bridge_pid" 2>/dev/null || true
    kill -QUIT "$nginx_pid" 2>/dev/null || true
    wait "$bridge_pid" "$nginx_pid" 2>/dev/null || true
}
trap shutdown EXIT
trap 'exit 0' TERM INT QUIT
# Alpine's ash supports wait -n. Failure of either essential process stops
# the container and lets its deployment restart policy recover both together.
set +e
wait -n "$bridge_pid" "$nginx_pid"
status=$?
exit "$status"
