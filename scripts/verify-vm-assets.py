#!/usr/bin/env python3
"""Reject partial or mismatched browser VM packages and write their provenance."""

import hashlib
import json
from pathlib import Path
import re
import sys


VM_ASSETS = (
    "arg-module.js",
    "load.js",
    "out.js",
    "qemu-system-x86_64.data",
    "qemu-system-x86_64.wasm",
)
LOADER_ANCHOR = "assert(arrayBuffer, 'Loading data file failed.');"
PACKAGE_SIZE_GUARD = (
    "assert(arrayBuffer.byteLength === REMOTE_PACKAGE_SIZE, "
    "'Virtual machine data package size mismatch. Reload to try again.');"
)
POLL_ANCHOR = "var ___syscall_poll = (fds, nfds, timeout) => PTY_wrapPoll(() => xterm_pty_old_poll(fds, nfds, timeout));"
NETWORK_POLL_CALL = "var ___syscall_poll = (fds, nfds, timeout) => PTY_wrapNetworkPoll(() => xterm_pty_old_poll(fds, nfds, timeout), timeout);"
NETWORK_POLL_WRAPPER = """var PTY_wrapNetworkPoll = (impl, timeout) => PTY_handleSleep(wakeUp => {
  // A synchronous main-thread poll proxy can starve browser socket events.
  // Yield the polling pthread before scanning, including nonblocking polls.
  const now = () => performance.now();
  const deadline = timeout < 0 ? Infinity : now() + timeout;
  const check = () => {
    const result = impl();
    if (result > 0 || (result < 0 && result !== -1006)) {
      wakeUp(result);
      return true;
    }
    if (timeout === 0 || now() >= deadline) {
      wakeUp(0);
      return true;
    }
    return false;
  };
  if (typeof ENVIRONMENT_IS_PTHREAD !== "undefined" && ENVIRONMENT_IS_PTHREAD &&
      typeof PTY_handleSleepWithAtomic === "function" && PTY_handleSleep === PTY_handleSleepWithAtomic) {
    // Never reuse the PTY readable-wait cell: it belongs to read/select.
    const cell = PTY_wrapNetworkPoll.waitCell ||
      (PTY_wrapNetworkPoll.waitCell = new Int32Array(new SharedArrayBuffer(4)));
    Atomics.wait(cell, 0, 0, 1);
    while (!check()) {
      Atomics.wait(cell, 0, 0, Math.max(0, Math.min(10, deadline - now())));
    }
    return;
  }
  // Asyncify's handleSleep really suspends until its callback completes.
  const rescan = () => {
    if (!check()) setTimeout(rescan, Math.max(0, Math.min(10, deadline - now())));
  };
  setTimeout(rescan, 0);
});"""


def patch_loader(loader):
    """Patch the pinned Emscripten loader exactly once, including on rebuilds."""
    assert loader.count(LOADER_ANCHOR) == 1, "Expected exactly one pinned Emscripten package assertion"
    size_checks = loader.count("assert(arrayBuffer.byteLength === REMOTE_PACKAGE_SIZE")
    if size_checks:
        assert size_checks == 1 and loader.count(PACKAGE_SIZE_GUARD) == 1, "Unexpected Emscripten package size guard"
        assert LOADER_ANCHOR + "\n        " + PACKAGE_SIZE_GUARD in loader, "Misplaced Emscripten package size guard"
        return loader
    return loader.replace(LOADER_ANCHOR, LOADER_ANCHOR + "\n        " + PACKAGE_SIZE_GUARD)


def patch_network_poll(glue):
    """Keep the pinned TTY read/select wrapper; replace only poll's caller."""
    assert glue.count("var PTY_wrapPoll = impl => PTY_handleSleep(wakeUp => {") == 1, "Expected exactly one pinned Emscripten PTY poll wrapper"
    assert glue.count("var PTY_handleSleep = PTY_handleSleepWithAtomic;") == 1, "Unexpected Emscripten PTY sleep mode"
    old_count = glue.count(POLL_ANCHOR)
    patched_count = glue.count(NETWORK_POLL_CALL)
    assert old_count + patched_count == 1, "Expected exactly one pinned Emscripten poll syscall"
    if patched_count:
        assert glue.count(NETWORK_POLL_WRAPPER) == 1, "Unexpected Emscripten network poll wrapper"
        assert glue.count("var PTY_wrapNetworkPoll =") == 1, "Duplicate Emscripten network poll wrapper"
        assert NETWORK_POLL_WRAPPER + "\n\n" + NETWORK_POLL_CALL in glue, "Misplaced Emscripten network poll wrapper"
        return glue
    assert "PTY_wrapNetworkPoll" not in glue, "Unexpected existing Emscripten network poll patch"
    return glue.replace(POLL_ANCHOR, NETWORK_POLL_WRAPPER + "\n\n" + NETWORK_POLL_CALL)


def verify(directory, guest_image, source):
    directory = Path(directory)
    for name in VM_ASSETS:
        path = directory / name
        assert path.is_file() and path.stat().st_size > 0, f"Missing or empty VM asset: {name}"
    args_text = (directory / "arg-module.js").read_text()
    args = json.loads(args_text.split("=", 1)[1].rstrip().rstrip(";"))
    assert args[args.index("-incoming") + 1] == "file:/pack/vm.state", "VM must restore its packaged snapshot"
    loader = (directory / "load.js").read_text()
    match = re.search(r"loadPackage\((\{.*\})\);", loader)
    assert match, "Missing Emscripten package metadata"
    metadata = json.loads(match.group(1))
    package = directory / "qemu-system-x86_64.data"
    assert package.stat().st_size == metadata["remote_package_size"], "Truncated data package"
    end = 0
    files = {}
    for item in metadata["files"]:
        assert item["start"] == end and item["end"] > end, "Invalid package offsets"
        end = item["end"]
        files[item["filename"]] = item
    assert end == metadata["remote_package_size"], "Package size and segments disagree"
    assert "/pack/rootfs.bin" in files and "/pack/bzImage" in files
    with package.open("rb") as packed:
        packed.seek(files["/pack/vm.state"]["start"])
        assert packed.read(4) == b"QEVM", "Invalid QEMU snapshot"
    assert (directory / "qemu-system-x86_64.wasm").read_bytes()[:4] == b"\0asm", "Invalid emulator"
    loader = patch_loader(loader)
    glue = patch_network_poll((directory / "out.js").read_text())
    (directory / "load.js").write_text(loader)
    (directory / "out.js").write_text(glue)
    hashes = {}
    for path in sorted(directory.iterdir()):
        # These two generated outputs must not hash themselves or each other.
        if not path.is_file() or path.name in ("asset-manifest.json", "asset-versions.conf"):
            continue
        digest = hashlib.sha256()
        with path.open("rb") as src:
            for chunk in iter(lambda: src.read(1024 * 1024), b""):
                digest.update(chunk)
        hashes[path.name] = {"sha256": digest.hexdigest(), "bytes": path.stat().st_size}
    versions = [
        "# Generated by verify-vm-assets.py; publish with this exact VM package.",
        'map "$uri:$arg_v" $web_ide_valid_asset {',
        "    default 0;",
    ]
    versions.extend(f'    "/{name}:{hashes[name]["sha256"]}" 1;' for name in VM_ASSETS)
    versions.append("}")
    (directory / "asset-versions.conf").write_text("\n".join(versions) + "\n")
    provenance = json.loads((Path(source) / "web-ide-source.json").read_text())
    manifest = {"guestImage": guest_image, "container2wasmRevision": provenance["revision"], "patches": provenance["patches"], "files": hashes}
    (directory / "asset-manifest.json").write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n")


if __name__ == "__main__":
    verify(*sys.argv[1:])
