import importlib.util
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("verify_assets", ROOT / "scripts/verify-vm-assets.py")
verify_assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify_assets)


class PackageValidation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        (self.directory / "arg-module.js").write_text("Module['arguments'] = [\"-incoming\", \"file:/pack/vm.state\"];")
        files = [
            {"filename": "/pack/rootfs.bin", "start": 0, "end": 4},
            {"filename": "/pack/bzImage", "start": 4, "end": 8},
            {"filename": "/pack/vm.state", "start": 8, "end": 16},
        ]
        # Keep the real pinned loader's processPackageData assertion and
        # metadata structure so the runtime guard executes in the same scope.
        self.loader = """function loadPackage(metadata) {
    var REMOTE_PACKAGE_SIZE = metadata['remote_package_size'];
    function assert(check, message) { if (!check) throw new Error(message); }
    function processPackageData(arrayBuffer) {
        assert(arrayBuffer, 'Loading data file failed.');
        assert(arrayBuffer.constructor.name === ArrayBuffer.name, 'bad input to processPackageData');
        globalThis.receivedBytes = arrayBuffer.byteLength;
    }
    globalThis.processPackageData = processPackageData;
}
loadPackage(""" + json.dumps({"files": files, "remote_package_size": 16}) + ");\n"
        (self.directory / "load.js").write_text(self.loader)
        self.glue = """var PTY_handleSleepWithAtomic = startAsync => {
  let result;
  startAsync(r => result = r);
  return result;
};
var PTY_handleSleep = PTY_handleSleepWithAtomic;
var PTY_wrapPoll = impl => PTY_handleSleep(wakeUp => {
  wakeUp(impl());
});
var ___syscall__newselect = () => PTY_wrapPoll(() => 0);
""" + verify_assets.POLL_ANCHOR + "\n"
        (self.directory / "out.js").write_text(self.glue)
        (self.directory / "qemu-system-x86_64.data").write_bytes(b"diskkernQEVMdata")
        (self.directory / "qemu-system-x86_64.wasm").write_bytes(b"\0asmtest")
        (self.directory / "web-ide-source.json").write_text(json.dumps({"revision": "pinned", "patches": {"patch": "sha"}}))

    def tearDown(self):
        self.temp.cleanup()

    def verify(self):
        verify_assets.verify(self.directory, "sha256:guest", self.directory)

    def test_complete_package_records_its_guest_image(self):
        self.verify()
        manifest = json.loads((self.directory / "asset-manifest.json").read_text())
        self.assertEqual(manifest["guestImage"], "sha256:guest")
        self.assertEqual(manifest["files"]["qemu-system-x86_64.data"]["bytes"], 16)

    def test_nginx_map_only_accepts_the_five_exact_published_versions(self):
        self.verify()
        manifest = json.loads((self.directory / "asset-manifest.json").read_text())
        versions = (self.directory / "asset-versions.conf").read_text()
        self.assertIn('map "$uri:$arg_v" $web_ide_valid_asset {', versions)
        self.assertIn("    default 0;", versions)
        entries = re.findall(r'^\s*"([^"]+)" 1;$', versions, re.MULTILINE)
        self.assertEqual(set(entries), {f"/{name}:{manifest['files'][name]['sha256']}" for name in verify_assets.VM_ASSETS})
        self.assertEqual(len(entries), 5)
        self.assertNotIn("asset-versions.conf", manifest["files"])
        self.assertNotIn("asset-manifest.json", manifest["files"])

    def test_loader_hash_is_computed_after_the_runtime_guard_is_inserted(self):
        original_hash = hashlib.sha256((self.directory / "load.js").read_bytes()).hexdigest()
        self.verify()
        loader = (self.directory / "load.js").read_bytes()
        manifest = json.loads((self.directory / "asset-manifest.json").read_text())
        published = manifest["files"]["load.js"]
        self.assertNotEqual(published["sha256"], original_hash)
        self.assertEqual(published["sha256"], hashlib.sha256(loader).hexdigest())
        self.assertEqual(published["bytes"], len(loader))
        self.assertIn(f'/load.js:{published["sha256"]}', (self.directory / "asset-versions.conf").read_text())

    def test_verification_is_byte_identical_when_repeated(self):
        self.verify()
        first = {name: (self.directory / name).read_bytes() for name in ("load.js", "out.js", "asset-versions.conf", "asset-manifest.json")}
        self.verify()
        self.assertEqual(first, {name: (self.directory / name).read_bytes() for name in first})
        self.assertEqual((self.directory / "load.js").read_text().count(verify_assets.PACKAGE_SIZE_GUARD), 1)
        self.assertEqual((self.directory / "out.js").read_text().count(verify_assets.NETWORK_POLL_WRAPPER), 1)

    def test_network_poll_patch_is_hashed_and_does_not_change_select_wrapper(self):
        self.verify()
        glue = (self.directory / "out.js").read_bytes()
        manifest = json.loads((self.directory / "asset-manifest.json").read_text())
        self.assertEqual(manifest["files"]["out.js"]["sha256"], hashlib.sha256(glue).hexdigest())
        self.assertIn("var ___syscall__newselect = () => PTY_wrapPoll(() => 0);", glue.decode())
        self.assertNotIn(verify_assets.POLL_ANCHOR, glue.decode())

    def test_missing_duplicate_or_changed_poll_anchors_fail_the_build(self):
        for glue in (
            self.glue.replace(verify_assets.POLL_ANCHOR, ""),
            self.glue + verify_assets.POLL_ANCHOR,
            self.glue.replace("var PTY_handleSleep = PTY_handleSleepWithAtomic;", "var PTY_handleSleep = otherMode;"),
            verify_assets.patch_network_poll(self.glue).replace("Atomics.wait(cell, 0, 0, 1);", "Atomics.wait(cell, 0, 0, 0);"),
        ):
            with self.subTest(glue=glue):
                (self.directory / "out.js").write_text(glue)
                with self.assertRaises(AssertionError):
                    self.verify()

    @unittest.skipUnless(shutil.which("node"), "Node is required for browser poll scheduling tests")
    def test_network_poll_yields_and_rescans_in_asyncify_and_real_atomic_worker(self):
        self.verify()
        glue = (self.directory / "out.js").read_text()
        # Execute the actual generated/patched wrapper, rather than another
        # implementation of its algorithm. Only the network readiness source
        # and the surrounding Emscripten runtime are test adapters.
        program = "const glue = " + json.dumps(glue) + ";\n" + r"""
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {Worker} = require('node:worker_threads');
const watchdog = setTimeout(() => { console.error('poll test timeout'); process.exit(2); }, 5000);
(async () => {
  const c = vm.createContext({performance, setTimeout, ENVIRONMENT_IS_PTHREAD:false});
  vm.runInContext(glue, c);
  c.PTY_handleSleep = start => new Promise(resolve => start(resolve));
  let scans = 0, ready = false;
  c.xterm_pty_old_poll = () => { scans++; return ready ? 3 : 0; };
  const result = c.___syscall_poll(0, 1, 1000);
  assert.equal(scans, 0, 'initial scan ran without yielding a macrotask');
  setTimeout(() => { ready = true; }, 0);
  assert.equal(await result, 3);
  assert(scans >= 2, 'socket readiness was not rescanned after its network task');
  for (const sentinel of [0, -1006]) {
    scans = 0;
    c.xterm_pty_old_poll = () => { scans++; return sentinel; };
    const immediate = c.___syscall_poll(0, 1, 0);
    assert.equal(scans, 0);
    assert.equal(await immediate, 0);
    assert.equal(scans, 1);
  }
  c.xterm_pty_old_poll = () => -27;
  assert.equal(await c.___syscall_poll(0, 1, -1), -27);
  c.xterm_pty_old_poll = () => 0;
  const before = performance.now();
  assert.equal(await c.___syscall_poll(0, 1, 20), 0);
  assert(performance.now() - before >= 19);

  const network = new SharedArrayBuffer(4);
  const workerCode = `
    const assert = require('node:assert/strict');
    const vm = require('node:vm');
    const {parentPort, workerData} = require('node:worker_threads');
    const readiness = new Int32Array(workerData.network);
    const waits = [];
    const nativeWait = Atomics.wait;
    const c = vm.createContext({performance, setTimeout, SharedArrayBuffer, Int32Array,
      ENVIRONMENT_IS_PTHREAD:true,
      Atomics:{wait(cell,index,value,timeout) {
        assert.equal(cell.byteLength, 4);
        assert.notEqual(cell.buffer, workerData.network);
        assert(timeout >= 0 && timeout <= 10);
        waits.push(timeout);
        return nativeWait(cell,index,value,timeout);
      }}
    });
    vm.runInContext(workerData.glue,c);
    for (const sentinel of [0,-1006]) {
      let scans=0; waits.length=0;
      c.xterm_pty_old_poll=()=>{scans++;return sentinel;};
      assert.equal(c.___syscall_poll(0,1,0),0);
      assert.equal(scans,1); assert.deepEqual(waits,[1]);
    }
    c.xterm_pty_old_poll=()=>-8; waits.length=0;
    assert.equal(c.___syscall_poll(0,1,-1),-8);
    assert.deepEqual(waits,[1]);
    c.xterm_pty_old_poll=()=>0; waits.length=0;
    const before=performance.now();
    assert.equal(c.___syscall_poll(0,1,20),0);
    assert(performance.now()-before>=19); assert(waits.length>=2);
    for (const timeout of [1000,-1]) {
      Atomics.store(readiness,0,0);
      let scans=0; waits.length=0;
      c.xterm_pty_old_poll=()=>{
        if (++scans===1) parentPort.postMessage({kind:'network-pending'});
        return Atomics.load(readiness,0) ? 7 : -1006;
      };
      assert.equal(c.___syscall_poll(0,1,timeout),7);
      assert(scans>=2); assert.equal(waits[0],1);
    }
    parentPort.postMessage({kind:'done'});
  `;
  await new Promise((resolve,reject) => {
    const worker = new Worker(workerCode,{eval:true,workerData:{glue,network}});
    worker.on('message', message => {
      if (message.kind==='network-pending') setTimeout(()=>Atomics.store(new Int32Array(network),0,1),0);
      if (message.kind==='done') resolve();
    });
    worker.on('error',reject);
    worker.on('exit',code=>{if(code) reject(new Error('atomic worker failed'));});
  });
  clearTimeout(watchdog);
})().catch(error=>{clearTimeout(watchdog);console.error(error);process.exitCode=1;});
"""
        completed = subprocess.run([shutil.which("node"), "-e", program], capture_output=True, text=True, timeout=10)
        self.assertEqual(completed.returncode, 0, completed.stderr)

    @unittest.skipUnless(shutil.which("node"), "Node is required for browser TTY poll tests")
    def test_browser_tty_poll_keeps_pollout_and_read_notifications(self):
        boot = (ROOT / "web/boot.js").read_text()
        match = re.search(r"mod\.TTY\.stream_ops\.poll = \(.*?\n    };", boot, re.DOTALL)
        self.assertIsNotNone(match, "Missing browser TTY poll hook")
        program = """const assert = require('node:assert/strict');
const slave={readable:false};
const readableCallbacks=[];
const mod={TTY:{stream_ops:{}}};
""" + match.group(0) + """
let cleanup;
const notify=()=>{};
notify.registerCleanupFunc=callback=>{cleanup=callback;};
assert.equal(mod.TTY.stream_ops.poll(null,10,notify),4);
assert.equal(readableCallbacks.length,1);
cleanup(); assert.equal(readableCallbacks.length,0);
slave.readable=true;
assert.equal(mod.TTY.stream_ops.poll(null,10,notify),5);
assert.equal(readableCallbacks.length,0);
"""
        completed = subprocess.run([shutil.which("node"), "-e", program], capture_output=True, text=True)
        self.assertEqual(completed.returncode, 0, completed.stderr)

    @unittest.skipUnless(shutil.which("node"), "Node is required to execute the generated loader")
    def test_runtime_rejects_short_and_oversized_cached_packages(self):
        self.verify()
        loader = (self.directory / "load.js").read_text()
        program = loader + """
const testAssert = require('node:assert/strict');
processPackageData(new ArrayBuffer(16));
testAssert.equal(globalThis.receivedBytes, 16);
for (const size of [0, 15, 17]) {
    testAssert.throws(() => processPackageData(new ArrayBuffer(size)), /data package size mismatch/);
}
"""
        completed = subprocess.run([shutil.which("node"), "-e", program], capture_output=True, text=True)
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_missing_or_duplicate_pinned_loader_anchor_cannot_be_published(self):
        for loader in (
            self.loader.replace(verify_assets.LOADER_ANCHOR, ""),
            self.loader.replace(verify_assets.LOADER_ANCHOR, verify_assets.LOADER_ANCHOR * 2),
        ):
            with self.subTest(loader=loader):
                (self.directory / "load.js").write_text(loader)
                with self.assertRaisesRegex(AssertionError, "exactly one pinned Emscripten"):
                    self.verify()
        self.assertFalse((self.directory / "asset-manifest.json").exists())

    def test_missing_emulator_glue_cannot_be_published(self):
        (self.directory / "out.js").unlink()
        with self.assertRaisesRegex(AssertionError, "Missing or empty VM asset: out.js"):
            self.verify()

    def test_truncated_package_cannot_be_published(self):
        (self.directory / "qemu-system-x86_64.data").write_bytes(b"disk")
        with self.assertRaisesRegex(AssertionError, "Truncated"):
            self.verify()

    def test_wrong_snapshot_offsets_cannot_be_published(self):
        (self.directory / "qemu-system-x86_64.data").write_bytes(b"diskkernXXXXdata")
        with self.assertRaisesRegex(AssertionError, "snapshot"):
            self.verify()


if __name__ == "__main__":
    unittest.main()
