#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
c2w="${root}/.tools/bin/c2w"
if [[ ! -x "${c2w}" ]]; then
  echo "c2w is missing. Build it with: git clone --depth 1 --branch v0.8.4 https://github.com/container2wasm/container2wasm.git ${root}/.tools/container2wasm && ( cd ${root}/.tools/container2wasm && go build -o ${root}/.tools/bin/c2w ./cmd/c2w )" >&2
  exit 1
fi

docker build --platform linux/amd64 -t web-ide-guest:local "${root}/guest"
mkdir -p "${root}/dist/htdocs"
"${c2w}" --to-js \
  --build-arg VM_MEMORY_SIZE_MB=1024 \
  --build-arg QEMU_MIGRATION=false \
  --build-arg SOURCE_REPO=https://github.com/container2wasm/container2wasm \
  --build-arg SOURCE_REPO_VERSION=v0.8.4 \
  web-ide-guest:local "${root}/dist/htdocs/"
docker build -f "${root}/nginx/Dockerfile" -t web-ide:local "${root}"
echo "Built image web-ide:local."
