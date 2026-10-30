import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const bootSource = (await readFile(new URL("../web/boot.js", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "")
  // The real emulator module is replaced by the existing runtime stub; its
  // URL selection is still exercised by Module.mainScriptUrlOrBlob below.
  .replace(/^  await import\(Module\.locateFile\("arg-module\.js"\)\);\n/m, "")
  .replace(/^  const \{ default: initEmscriptenModule \} = await import\(Module\.locateFile\("out\.js"\)\);\n/m, "");
const htmlSource = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
const ptySource = await readFile(new URL("../web/vendor/xterm-pty.js", import.meta.url), "utf8");
const pageScripts = [...htmlSource.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
const assetNames = ["load.js", "arg-module.js", "out.js", "qemu-system-x86_64.wasm", "qemu-system-x86_64.data"];
function manifest() {
  return { files: Object.fromEntries(assetNames.map((name, index) => [name, { sha256: String(index + 1).repeat(64), bytes: 100 + index }])) };
}

function harness() {
  const elements = Object.fromEntries(["status", "bar", "boot", "ide"].map((id) => [id, { style: {}, hidden: id === "ide" }]));
  const scripts = [];
  const events = new Map();
  let writePacket;
  const context = vm.createContext({
    TextDecoder,
    TextEncoder,
    AbortSignal,
    URL,
    crypto: webcrypto,
    addEventListener: (name, callback) => events.set(name, callback),
    removeEventListener: (name, callback) => { if (events.get(name) === callback) events.delete(name); },
    location: { protocol: "http:", hostname: "localhost", host: "localhost:8090", origin: "http://localhost:8090" },
    document: {
      getElementById: (id) => elements[id],
      createElement: () => ({}),
      body: { appendChild: (script) => scripts.push(script) },
    },
    crossOriginIsolated: false,
    openpty: () => ({
      master: { onWrite: (callback) => { writePacket = callback; } },
      slave: { onReadable() {} },
    }),
    initEmscriptenModule: async (module) => { module.onRuntimeInitialized(); },
    fetch: async () => ({ status: 200, ok: true, type: "basic", json: async () => manifest() }),
    setTimeout,
    webIdeWorkspace: { initialize: async () => {} },
  });
  context.window = context;
  for (const script of pageScripts) vm.runInContext(script, context);
  context.__webIdeBoot.session = context.newSessionToken();
  context.configureAssets(manifest());
  // ES modules have their own lexical scope, unlike the page's inline script.
  return { context, elements, scripts, events, loadBoot: () => vm.runInContext(`(() => {\n${bootSource}\n})()`, context), write: (...args) => writePacket(...args) };
}

test("PTY decoding preserves split UTF-8 and startup markers, and readiness survives log rotation", () => {
  const h = harness();
  h.loadBoot();
  const bytes = new TextEncoder().encode("Booting café\nWEB_IDE_CODE_SERVER_HTTP 200\n");
  let acknowledgements = 0;
  for (const byte of bytes) h.write([Uint8Array.of(byte), () => { acknowledgements++; }]);
  assert.equal(acknowledgements, bytes.length);
  assert.match(h.context.__guestLog, /Booting café\nWEB_IDE_CODE_SERVER_HTTP 200\n/);
  assert.equal(h.context.__webIdeBoot.guestReady, true);
  h.write([new TextEncoder().encode("Later output\n".repeat(300))]);
  assert.doesNotMatch(h.context.__guestLog, /WEB_IDE_CODE_SERVER_HTTP/);
  assert.equal(h.context.__webIdeBoot.guestReady, true);
});

test("failure markers do not report a ready server, and Emscripten output retains line boundaries", () => {
  const h = harness();
  h.loadBoot();
  h.context.Module.print("WEB_IDE_CODE_SERVER_HTTP_FAIL");
  h.context.Module.printErr("Next line");
  assert.equal(h.context.__webIdeBoot.guestReady, false);
  assert.match(h.context.__guestLog, /WEB_IDE_CODE_SERVER_HTTP_FAIL\nNext line\n/);
});

test("runtime aborts remain visible and prevent the editor from opening", async () => {
  const h = harness();
  h.loadBoot();
  h.context.Module.onAbort("Wasm memory allocation failed");
  h.context.Module.setStatus("Downloading data... (1/2)");
  assert.match(h.elements.status.textContent, /could not start/);
  assert.match(h.context.__webIdeBoot.error, /memory allocation failed/);
  assert.equal(await h.context.editorReady(), false);
  assert.equal(h.elements.ide.hidden, true);
});

test("restored guests use actual HTTP health without replaying a pre-snapshot console marker", async () => {
  const h = harness();
  let requests = 0;
  h.context.fetch = async (url) => {
    assert.equal(url, `/sessions/${h.context.__webIdeBoot.session}/health`);
    requests++;
    return { status: requests === 1 ? 503 : 200, type: "basic" };
  };
  assert.equal(await h.context.editorReady(), false);
  assert.equal(requests, 0);
  h.context.__webIdeBoot.runtimeReady = true;
  assert.equal(await h.context.editorReady(), false);
  assert.equal(await h.context.editorReady(), true);
  assert.equal(h.context.__webIdeBoot.guestReady, true);
});

test("the data loader finishes before the module starts, then a healthy guest opens the editor", async () => {
  const h = harness();
  const started = h.context.startVirtualMachine();
  await new Promise(setImmediate);
  assert.equal(h.scripts.length, 1);
  assert.equal(h.scripts[0].src, `http://localhost:8090/load.js?v=${"1".repeat(64)}`);
  h.scripts[0].onload();
  await new Promise(setImmediate);
  assert.equal(h.scripts.length, 2);
  assert.match(h.scripts[1].src, /^\/boot\.js\?/);
  assert.equal(h.scripts[1].type, "module");
  h.context.__webIdeBoot.runtimeReady = true;
  h.scripts[1].onload();
  await new Promise(setImmediate);
  assert.equal(h.scripts[2].src, "/workspace.js");
  assert.equal(h.elements.ide.hidden, true, "editor opened before restoring the workspace");
  h.scripts[2].onload();
  await started;
  assert.equal(h.elements.ide.src, `http://localhost:18080/sessions/${h.context.__webIdeBoot.session}/editor/?folder=/opt/web-ide/demos`);
  assert.equal(h.elements.ide.hidden, false);
  assert.equal(h.elements.boot.hidden, true);
  assert.equal(h.elements.bar.style.width, "100%");
});

test("a loader error stops startup with an actionable message", async () => {
  const h = harness();
  const started = h.context.startVirtualMachine();
  await new Promise(setImmediate);
  h.scripts[0].onerror();
  await started;
  assert.equal(h.scripts.length, 1);
  assert.match(h.context.__webIdeBoot.error, /Could not load .*\/load.js\?v=/);
  assert.match(h.elements.status.textContent, /Reload to try again/);
  assert.equal(h.elements.ide.hidden, true);
});

test("a failed workspace restore cannot open an empty editor or retry into a fresh workspace", async () => {
  const h = harness();
  h.context.__webIdeBoot.runtimeReady = true;
  h.context.webIdeWorkspace.initialize = async () => { throw new Error("stored backup is corrupt"); };
  const opened = h.context.openEditor();
  await new Promise(setImmediate);
  assert.equal(h.scripts[0].src, "/workspace.js");
  h.scripts[0].onload();
  await opened;
  assert.equal(h.elements.ide.hidden, true);
  assert.match(h.context.__webIdeBoot.error, /corrupt/);
  assert.match(h.elements.status.textContent, /backup is unchanged/);
});

test("the diagnostic console feeds the bundled PTY's real guest input queue", () => {
  const h = harness();
  h.context.self = h.context;
  vm.runInContext(ptySource, h.context);
  h.loadBoot();
  h.context.__webIDE.sendSerial("echo serial-check\r");
  assert.equal(String.fromCharCode(...h.context.Module.pty.read()), "echo serial-check\n");
  assert.throws(() => h.context.__webIDE.sendSerial(null), /Serial input must be text/);
});

test("the bundled PTY accepts Emscripten's plain TCSETS configuration and remains readable", () => {
  const h = harness();
  h.context.self = h.context;
  vm.runInContext(ptySource, h.context);
  h.loadBoot();
  const slave = h.context.Module.pty;
  const initial = slave.ioctl("TCGETS");
  // emscripten-pty.js passes these numeric flags and cc directly, without
  // a Termios prototype. The older 0.9.4 bundle stored this object verbatim,
  // then failed the next TCGETS with "termios.clone is not a function".
  const config = JSON.parse(JSON.stringify({
    iflag: 0,
    oflag: 0,
    cflag: initial.cflag,
    lflag: 0,
    cc: Array.from(initial.cc),
  }));
  assert.equal(typeof config.clone, "undefined");
  slave.ioctl("TCSETS", config);
  for (let attempt = 0; attempt < 2; attempt++) {
    const actual = slave.ioctl("TCGETS");
    for (const name of ["iflag", "oflag", "cflag", "lflag"]) assert.equal(actual[name], config[name]);
    assert.deepEqual(Array.from(actual.cc), config.cc);
    assert.equal(actual.ICANON_P, false);
  }
  h.context.__webIDE.sendSerial("serial-raw-check\r");
  assert.equal(String.fromCharCode(...slave.read()), "serial-raw-check\r");
});

test("separate page starts receive separate crypto tokens and route their own guest transport", () => {
  const first = harness();
  const second = harness();
  first.loadBoot();
  second.loadBoot();
  const firstSession = first.context.__webIdeBoot.session;
  const secondSession = second.context.__webIdeBoot.session;
  assert.match(firstSession, /^[a-f0-9]{32}$/);
  assert.match(secondSession, /^[a-f0-9]{32}$/);
  assert.notEqual(firstSession, secondSession);
  assert.equal(first.context.Module.websocket.url, `ws://localhost:8090/sessions/${firstSession}/net`);
  assert.equal(second.context.Module.websocket.url, `ws://localhost:8090/sessions/${secondSession}/net`);
});

test("manifest versions apply to glue, Wasm and disk/snapshot without a fallback URL", () => {
  const h = harness();
  const locate = h.context.Module.locateFile;
  h.loadBoot();
  assert.equal(h.context.Module.locateFile, locate, "boot replaced the verified locator");
  assert.equal(h.context.Module.mainScriptUrlOrBlob, `http://localhost:8090/out.js?v=${"3".repeat(64)}`);
  for (const [index, name] of assetNames.entries()) {
    assert.equal(locate(name), `http://localhost:8090/${name}?v=${String(index + 1).repeat(64)}`);
  }
  assert.throws(() => locate("unlisted.wasm"), /Unlisted virtual machine asset/);
  const deployed = manifest();
  deployed.files["qemu-system-x86_64.data"].sha256 = "a".repeat(64);
  h.context.configureAssets(deployed);
  assert.equal(h.context.Module.locateFile("qemu-system-x86_64.data"), `http://localhost:8090/qemu-system-x86_64.data?v=${"a".repeat(64)}`);
});

test("startup fetches a fresh manifest and stops visibly if any required asset is absent or invalid", async () => {
  for (const invalid of [
    { files: {} },
    { files: { ...manifest().files, "out.js": { sha256: "invalid", bytes: 123 } } },
    { files: { ...manifest().files, "../out.js": { sha256: "a".repeat(64), bytes: 123 } } },
  ]) {
    const h = harness();
    h.context.fetch = async (url, options) => {
      assert.equal(url, "/asset-manifest.json");
      assert.equal(options.cache, "no-store");
      return { ok: true, json: async () => invalid };
    };
    await h.context.startVirtualMachine();
    assert.equal(h.scripts.length, 0, "invalid manifest started an unversioned loader");
    assert.match(h.context.__webIdeBoot.error, /virtual machine asset/);
    assert.match(h.elements.status.textContent, /version could not be verified/);
  }
});

test("a generated data-package rejection stops startup visibly instead of waiting for a guest", () => {
  const h = harness();
  let handled = false;
  const url = h.context.Module.locateFile("qemu-system-x86_64.data");
  h.events.get("unhandledrejection")({ reason: new Error(`409: ${url}`), preventDefault() { handled = true; } });
  assert.equal(handled, true);
  assert.match(h.context.__webIdeBoot.error, /409/);
  assert.match(h.elements.status.textContent, /files changed or could not load/);
});
