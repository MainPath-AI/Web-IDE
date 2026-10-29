#!/bin/bash
set -euo pipefail
docker rm -f web-ide >/dev/null 2>&1 || true
docker run --name web-ide --rm -p 8080:80 -p 18080:18080 web-ide:local
