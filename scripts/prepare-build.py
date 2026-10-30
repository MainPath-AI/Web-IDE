#!/usr/bin/env python3
"""Prepare pinned, patched container2wasm assets without changing .tools."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

REVISION = "6ed3d98882a2b22eafc1334f574c364a5b2b8c47"
UPSTREAM = "https://github.com/container2wasm/container2wasm.git"
ROOT = Path(__file__).resolve().parent.parent
PATCHES = ROOT / "patches/container2wasm"


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as src:
        for chunk in iter(lambda: src.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def file_hashes(directory):
    return {
        str(path.relative_to(directory)): sha256(path)
        for path in sorted(directory.rglob("*"))
        if path.is_file() and path.name != "web-ide-source.json"
    }


def prepare():
    inputs = {path.name: sha256(path) for path in sorted(PATCHES.iterdir()) if path.is_file()}
    inputs["warm-guest.mjs"] = sha256(ROOT / "scripts/warm-guest.mjs")
    fingerprint = hashlib.sha256(json.dumps(inputs, sort_keys=True).encode()).hexdigest()
    toolchain = ROOT / "dist/toolchain"
    toolchain.mkdir(parents=True, exist_ok=True)
    destination = toolchain / f"container2wasm-{REVISION[:12]}-{fingerprint[:16]}"
    manifest_path = destination / "web-ide-source.json"
    if destination.exists():
        manifest = json.loads(manifest_path.read_text())
        if manifest["revision"] != REVISION or manifest["patches"] != inputs or manifest["files"] != file_hashes(destination):
            raise RuntimeError(f"Generated toolchain was changed: {destination}; preserve it and choose a fresh output directory.")
        return destination

    source = ROOT / ".tools/container2wasm"
    if not source.exists() or subprocess.run(
        ["git", "cat-file", "-e", f"{REVISION}^{{commit}}"], cwd=source,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    ).returncode:
        source = toolchain / "upstream"
        if not source.exists():
            subprocess.run(["git", "clone", "--depth", "1", "--branch", "v0.8.4", UPSTREAM, str(source)], check=True, stdout=sys.stderr)
        found = subprocess.check_output(["git", "rev-parse", "v0.8.4^{commit}"], cwd=source, text=True).strip()
        if found != REVISION:
            raise RuntimeError(f"Unexpected container2wasm v0.8.4 revision: {found}")

    # Export the committed upstream tree, then apply only our versioned changes.
    # Existing local edits, binaries, credentials, and .git data are never copied.
    stage = Path(tempfile.mkdtemp(prefix=".prepare-", dir=toolchain))
    try:
        archive = subprocess.Popen(["git", "archive", REVISION], cwd=source, stdout=subprocess.PIPE)
        with tarfile.open(fileobj=archive.stdout, mode="r|") as tar:
            for member in tar:
                target = (stage / member.name).resolve()
                if not target.is_relative_to(stage.resolve()):
                    raise RuntimeError(f"Unsafe upstream archive path: {member.name}")
                if member.issym() and not (target.parent / member.linkname).resolve().is_relative_to(stage.resolve()):
                    raise RuntimeError(f"Unsafe upstream archive link: {member.name}")
                if not (member.isdir() or member.isfile() or member.issym()):
                    raise RuntimeError(f"Unexpected upstream archive entry: {member.name}")
                # macOS ships Python 3.9; newer Pythons provide an additional
                # extraction filter, beyond the checks above for the pinned tree.
                options = {"filter": "data"} if hasattr(tarfile, "data_filter") else {}
                tar.extract(member, stage, **options)
        if archive.wait() != 0:
            raise RuntimeError("git archive failed")
        subprocess.run(["patch", "--batch", "--forward", "--fuzz=0", "-p1", "-i", str(PATCHES / "web-ide.patch")], cwd=stage, check=True, stdout=sys.stderr)
        shutil.copyfile(PATCHES / "get-qemu-state.go", stage / "cmd/get-qemu-state/main.go")
        shutil.copyfile(PATCHES / "get-qemu-state_test.go", stage / "cmd/get-qemu-state/main_test.go")
        shutil.copyfile(PATCHES / "web-ide-clock.go", stage / "cmd/init/web-ide-clock.go")
        shutil.copyfile(PATCHES / "web-ide-clock_test.go", stage / "cmd/init/web-ide-clock_test.go")
        shutil.copyfile(PATCHES / "web-ide-spec_test.go", stage / "cmd/create-spec/web-ide-spec_test.go")
        (stage / "web-ide").mkdir()
        shutil.copyfile(ROOT / "scripts/warm-guest.mjs", stage / "web-ide/warm-guest.mjs")
        manifest = {"upstream": UPSTREAM, "revision": REVISION, "patches": inputs, "files": file_hashes(stage)}
        (stage / "web-ide-source.json").write_text(json.dumps(manifest, sort_keys=True, indent=2) + "\n")
        os.rename(stage, destination)
    except BaseException:
        shutil.rmtree(stage)
        raise
    return destination


if __name__ == "__main__":
    print(prepare())
