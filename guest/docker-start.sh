#!/bin/bash
set -euo pipefail
if curl --silent --fail --unix-socket /var/run/docker.sock http://localhost/_ping >/dev/null; then
  echo "Docker is already running."
  exit 0
fi
mkdir -p /var/lib/docker /var/run
# Start on demand so ordinary editing does not pay Docker's startup cost.
dockerd --storage-driver=vfs --exec-opt native.cgroupdriver=cgroupfs \
  --log-level=error >/var/log/docker.log 2>&1 </dev/null &
for ((attempt=0; attempt<180; attempt++)); do
  if curl --silent --fail --unix-socket /var/run/docker.sock http://localhost/_ping >/dev/null; then
    echo "Docker is ready inside the browser guest."
    exit 0
  fi
  sleep 1
done
echo "Docker did not become ready. See /var/log/docker.log." >&2
exit 1
