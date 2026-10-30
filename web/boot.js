import "./vendor/xterm-pty.js";

const statusEl = document.getElementById("status");
const barEl = document.getElementById("bar");

const { master, slave } = openpty();
// Browser developer tools can inspect the actual guest console without a
// separate host shell or an exposed remote command endpoint.
window.__webIDE = Object.freeze({
  sendSerial(text) {
    if (typeof text !== "string") throw new TypeError("Serial input must be text");
    slave.ldisc.writeFromLower(text);
  },
  readSerial: () => window.__guestLog || "",
});
const guestLines = [];
const guestDecoder = new TextDecoder();
const bootState = window.__webIdeBoot ||= {};
let pendingGuestLine = "";

bootState.runtimeReady = false;
bootState.guestReady = false;
bootState.error = null;

function inspectGuest(line) {
  const ready = line.match(/WEB_IDE_CODE_SERVER_HTTP\s+([1-5]\d\d)\b/);
  if (ready && Number(ready[1]) < 400) {
    // Keep this independently of the bounded log. A busy console must not
    // make a guest which has already started appear unready again.
    bootState.guestReady = true;
    bootState.httpStatus = Number(ready[1]);
  }
  if (line.includes("WEB_IDE_CODE_SERVER_STARTING")) {
    setProgress("Starting VS Code in the virtual machine", NaN);
  }
}

function noteGuest(text) {
  // PTY writes can end inside a UTF-8 character or a readiness marker.
  // Preserve both boundaries instead of treating each packet as a line.
  pendingGuestLine += String(text).replace(/\r/g, "");
  const lines = pendingGuestLine.split("\n");
  pendingGuestLine = lines.pop();
  for (const line of lines) {
    inspectGuest(line);
    guestLines.push(line);
    if (guestLines.length > 240) guestLines.shift();
  }
  inspectGuest(pendingGuestLine);
  pendingGuestLine = pendingGuestLine.slice(-16000);
  window.__guestLog = [...guestLines, pendingGuestLine].join("\n").slice(-16000);
}

master.onWrite((packet) => {
  const bytes = packet[0];
  const done = packet[1];
  try {
    noteGuest(guestDecoder.decode(bytes, { stream: true }));
  } finally {
    if (typeof done === "function") done();
  }
});

function setProgress(label, ratio) {
  if (bootState.error) {
    label = "The virtual machine could not start. Reload to try again.";
    ratio = 0;
  }
  if (statusEl) statusEl.textContent = label;
  if (barEl && Number.isFinite(ratio)) {
    barEl.style.width = `${Math.max(4, Math.min(100, ratio * 100))}%`;
  }
}

Module.setStatus = (text) => {
  const match = String(text).match(/([0-9.]+)\s*\/\s*([0-9.]+)/);
  if (match) {
    setProgress(text, Number(match[1]) / Number(match[2]));
    return;
  }
  setProgress(text || "Preparing the virtual machine", NaN);
};

const guestMac = "02:00:00:00:00:01";
const socketScheme = location.protocol === "https:" ? "wss:" : "ws:";
Module.websocket = { url: `${socketScheme}//${location.host}/sessions/${bootState.session}/net` };
Module.pty = slave;
Module.print = (text) => noteGuest(`${text}\n`);
Module.printErr = (text) => noteGuest(`${text}\n`);
Module.onRuntimeInitialized = () => {
  if (bootState.error) return;
  bootState.runtimeReady = true;
  setProgress("Starting Linux in your browser", NaN);
};
Module.onAbort = (reason) => {
  bootState.error = String(reason);
  setProgress("The virtual machine could not start. Reload to try again.", 0);
};

const info = `t:${Math.round(Date.now() / 1000)}\nn:${guestMac}\n`;

async function start(packInfo) {
  if (!/^[a-f0-9]{32}$/.test(bootState.session || "")) {
    throw new Error("Missing guest session");
  }
  if (typeof Module.locateFile !== "function") {
    throw new Error("Missing verified virtual machine assets");
  }
  // Keep all generated glue, disk/snapshot data and Wasm on the same
  // manifest version, including scripts imported by emulator workers.
  Module.mainScriptUrlOrBlob = Module.locateFile("out.js");
  await import(Module.locateFile("arg-module.js"));
  const { default: initEmscriptenModule } = await import(Module.locateFile("out.js"));
  Module.preRun = Module.preRun || [];
  Module.preRun.push((mod) => {
    try {
      mod.FS.mkdir("/pack");
    } catch {
      // The data pack already created /pack.
    }
    mod.FS.writeFile("/pack/info", packInfo);
  });
  const readableCallbacks = [];
  slave.onReadable(() => {
    readableCallbacks.splice(0).forEach((callback) => callback());
  });
  Module.preRun.push((mod) => {
    if (!mod.TTY || !mod.TTY.stream_ops) return;
    mod.TTY.stream_ops.poll = (_stream, _timeout, notifyCallback) => {
      if (slave.readable) return 5;
      if (notifyCallback != null) {
        notifyCallback.registerCleanupFunc(() => {
          const index = readableCallbacks.indexOf(notifyCallback);
          if (index !== -1) readableCallbacks.splice(index, 1);
        });
        readableCallbacks.push(notifyCallback);
      }
      return 4;
    };
  });
  await initEmscriptenModule(Module);
}

setProgress("Loading the virtual machine", 0.08);
start(info).catch((error) => {
  bootState.error = String(error);
  setProgress("The virtual machine could not start. Reload to try again.", 0);
});
