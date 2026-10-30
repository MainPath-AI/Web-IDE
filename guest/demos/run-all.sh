#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
echo "--- python ---"
python python/hello.py
echo "--- node ---"
node node/hello.js
echo "--- hugo ---"
(cd hugo && hugo --quiet && test -f public/index.html && echo "hugo public/index.html ok")
