#!/bin/bash
set -euo pipefail
name="${WEB_IDE_CONTAINER:-web-ide}"
image="${WEB_IDE_IMAGE:-web-ide:local}"
web_port="${WEB_IDE_PORT:-8090}"
if docker container inspect "${name}" >/dev/null 2>&1; then
  echo "Container ${name} already exists. Choose another WEB_IDE_CONTAINER or manage that container explicitly." >&2
  exit 1
fi
echo "Open http://127.0.0.1:${web_port}/ in Chrome."
exec docker run --name "${name}" \
  -p "127.0.0.1:${web_port}:80" \
  -p "127.0.0.1:18080:18080" \
  "${image}"
