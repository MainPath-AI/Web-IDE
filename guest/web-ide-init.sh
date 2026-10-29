#!/bin/bash
set -o pipefail
. /root/.asdf/asdf.sh
cd /opt/web-ide/demos

echo "WEB_IDE_READY arch=$(uname -m)"
python -c 'import platform; print("WEB_IDE_PYTHON", platform.python_version(), platform.machine())' || echo "WEB_IDE_PYTHON_FAIL"

(
    node -e 'console.log("WEB_IDE_NODE", process.version, process.arch)' || echo "WEB_IDE_NODE_FAIL"
    hugo version | head -n 1 | sed 's/^/WEB_IDE_HUGO /' || echo "WEB_IDE_HUGO_FAIL"
) &

if command -v code-server >/dev/null 2>&1; then
    code-server \
        --auth none \
        --bind-addr 0.0.0.0:8080 \
        --disable-telemetry \
        --user-data-dir /root/.local/share/code-server \
        /opt/web-ide/demos >/var/log/code-server.log 2>&1 &
    echo "WEB_IDE_CODE_SERVER_STARTING"
    (
        ok=0
        for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
            code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8080/ || true)"
            if [ -n "$code" ] && [ "$code" != "000" ]; then
                echo "WEB_IDE_CODE_SERVER_HTTP $code"
                ok=1
                break
            fi
            sleep 5
        done
        [ "$ok" -eq 1 ] || echo "WEB_IDE_CODE_SERVER_HTTP_FAIL"
    ) &
else
    echo "WEB_IDE_CODE_SERVER_MISSING"
fi

if command -v dockerd >/dev/null 2>&1; then
    (
        dockerd >/var/log/dockerd.log 2>&1 &
        docker_up=0
        for _ in 1 2 3 4 5 6 7 8 9 10; do
            if timeout 3 docker info >/var/log/docker-info.txt 2>&1; then
                docker_up=1
                break
            fi
            sleep 2
        done
        if [ "$docker_up" -eq 1 ]; then
            echo "WEB_IDE_DOCKER_UP"
        else
            echo "WEB_IDE_DOCKER_DOWN"
            if [ -f /var/log/dockerd.log ]; then
                tail -n 8 /var/log/dockerd.log | while IFS= read -r line; do
                    echo "WEB_IDE_DOCKER_LOG $line"
                done
            fi
        fi
    ) &
else
    echo "WEB_IDE_DOCKER_MISSING"
fi

exec bash --login
