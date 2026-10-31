#!/bin/bash
set -euo pipefail
if curl --silent --fail --connect-timeout 1 --max-time 2 --unix-socket /var/run/docker.sock http://localhost/_ping >/dev/null 9>&-; then
  echo "Docker is already running."
  exit 0
fi
mkdir -p /var/lib/docker /var/run
exec 9>/var/run/web-ide-docker.lock
flock 9
if curl --silent --fail --connect-timeout 1 --max-time 2 --unix-socket /var/run/docker.sock http://localhost/_ping >/dev/null 9>&-; then
  echo "Docker is already running."
  exit 0
fi
echo "Starting Docker inside the browser guest..."
# runc's sysfs mount hides the outer VM init's cgroup2 mount. Docker needs
# the guest's controller hierarchy visible in its own mount namespace.
if [[ ! -f /sys/fs/cgroup/cgroup.controllers && ! -d /sys/fs/cgroup/devices ]]; then
  mkdir -p /sys/fs/cgroup
  mount -t cgroup2 none /sys/fs/cgroup
fi
# Docker's managed-containerd startup has a short fixed timeout. Prepare the
# bundled runtime independently so emulated startup can finish first.
runtime_dir=/var/run/web-ide-containerd
runtime_socket="${runtime_dir}/containerd.sock"
mkdir -p "${runtime_dir}" /var/lib/web-ide-containerd
cat >"${runtime_dir}/config.toml" <<CONFIG
version = 2
root = "/var/lib/web-ide-containerd"
state = "${runtime_dir}/state"
disabled_plugins = ["io.containerd.grpc.v1.cri"]
[grpc]
  address = "${runtime_socket}"
[debug]
  level = "error"
CONFIG
runtime_pid="$(cat "${runtime_dir}/pid" 2>/dev/null || true)"
if [[ ! "${runtime_pid}" =~ ^[0-9]+$ ]] ||
   [[ "$(readlink "/proc/${runtime_pid}/exe" 2>/dev/null || true)" != /usr/local/bin/containerd ]]; then
  containerd --config "${runtime_dir}/config.toml" >/var/log/containerd.log 2>&1 </dev/null 9>&- &
  runtime_pid=$!
  echo "${runtime_pid}" >"${runtime_dir}/pid"
fi
if ! ctr --address "${runtime_socket}" --connect-timeout 240s --timeout 240s version >/dev/null 2>&1 9>&-; then
  echo "Containerd did not become ready. See /var/log/containerd.log." >&2
  exit 1
fi
# Start on demand so ordinary editing does not pay Docker's startup cost.
dockerd --containerd "${runtime_socket}" --storage-driver=vfs --exec-opt native.cgroupdriver=cgroupfs \
  --log-level=info >/var/log/docker.log 2>&1 </dev/null 9>&- &
docker_pid=$!
for ((attempt=0; attempt<180; attempt++)); do
  if curl --silent --fail --connect-timeout 1 --max-time 2 --unix-socket /var/run/docker.sock http://localhost/_ping >/dev/null 9>&-; then
    echo "Docker is ready inside the browser guest."
    exit 0
  fi
  if ! kill -0 "${docker_pid}" 2>/dev/null; then
    echo "Docker stopped during startup. See /var/log/docker.log." >&2
    exit 1
  fi
  sleep 1
done
echo "Docker did not become ready. See /var/log/docker.log." >&2
exit 1
