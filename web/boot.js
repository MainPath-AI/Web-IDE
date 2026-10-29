import "https://unpkg.com/xterm@5.3.0/lib/xterm.js";
import "https://unpkg.com/xterm-pty@0.9.4/index.js";
import "./arg-module.js";
import initEmscriptenModule from "./out.js";

const statusEl = document.getElementById("status");
const barEl = document.getElementById("bar");
const bootEl = document.getElementById("boot");
const workspaceEl = document.getElementById("workspace");
const guestStatusEl = document.getElementById("guest-status");

const xterm = new Terminal({
  fontFamily: "IBM Plex Mono, ui-monospace, Menlo, monospace",
  fontSize: 14,
  theme: { background: "#121417", foreground: "#e7e4dc", cursor: "#d6a15a" },
});
xterm.open(document.getElementById("terminal"));
window.__term = xterm;

const { master, slave } = openpty();
xterm.loadAddon(master);

const seen = new Set();
let ready = false;

function note(line) {
  const text = String(line);
  if (text.includes("WEB_IDE_READY")) guestStatusEl.textContent = "Shell ready";
  if (text.includes("WEB_IDE_PYTHON ")) guestStatusEl.textContent = text.trim();
  if (text.includes("WEB_IDE_NODE ")) guestStatusEl.textContent = text.trim();
  if (text.includes("WEB_IDE_CODE_SERVER_HTTP ")) {
    const port = new URLSearchParams(location.search).get("idePort") || "18080";
    const ide = document.getElementById("ide");
    ide.src = `${location.protocol}//${location.hostname}:${port}/`;
    ide.hidden = false;
    guestStatusEl.textContent = "code-server is open";
  }
  if (text.includes("WEB_IDE_DOCKER_UP")) guestStatusEl.textContent = "Docker is running in the guest";
  if (text.includes("WEB_IDE_DOCKER_DOWN")) {
    guestStatusEl.textContent = "Docker daemon did not start";
  }
  if (!ready && text.includes("WEB_IDE_READY")) {
    ready = true;
    bootEl.hidden = true;
    workspaceEl.hidden = false;
    xterm.focus();
  }
}

const decoder = new TextDecoder();
const originalWrite = slave.write.bind(slave);
window.__guestLog = "";
let pending = "";
slave.write = (data) => {
  let chunk = "";
  try {
    if (typeof data === "string") chunk = data;
    else if (typeof data === "number") chunk = String.fromCharCode(data);
    else if (Array.isArray(data)) chunk = decoder.decode(Uint8Array.from(data));
    else if (ArrayBuffer.isView(data)) chunk = decoder.decode(data);
    else if (data instanceof ArrayBuffer) chunk = decoder.decode(new Uint8Array(data));
  } catch {
    chunk = "";
  }
  if (chunk) {
    window.__guestLog = (window.__guestLog + chunk).slice(-6000);
    pending += chunk;
    const parts = pending.split("\n");
    pending = parts.pop() || "";
    for (const line of parts) {
      const clean = line.replace(/\r/g, "");
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        note(clean);
      }
    }
  }
  return originalWrite(data);
};

function setProgress(label, ratio) {
  statusEl.textContent = label;
  if (Number.isFinite(ratio)) {
    barEl.style.width = `${Math.max(4, Math.min(100, ratio * 100))}%`;
  }
}

Module.setStatus = (text) => {
  const match = String(text).match(/([0-9.]+)\s*\/\s*([0-9.]+)/);
  if (match) {
    setProgress(text, Number(match[1]) / Number(match[2]));
    return;
  }
  setProgress(text || "Preparing the guest", NaN);
};

const guestMac = "02:00:00:00:00:01";
const socketScheme = location.protocol === "https:" ? "wss:" : "ws:";
Module.websocket = { url: `${socketScheme}//${location.host}/qemu-net` };
Module.pty = slave;
Module.mainScriptUrlOrBlob = `${location.origin}/out.js`;
Module.locateFile = (path) => `${location.origin}/${path}`;
Module.print = (text) => note(text);
Module.printErr = (text) => note(text);

const info = `t:${Math.round(Date.now() / 1000)}\nn:${guestMac}\n`;

function start(packInfo) {
  Module.preRun = Module.preRun || [];
  Module.preRun.push((mod) => {
    try {
      mod.FS.mkdir("/pack");
    } catch {
      // The data pack already created /pack.
    }
    mod.FS.writeFile("/pack/info", packInfo);
  });
  initEmscriptenModule(Module).then(() => {
    const previousPoll = Module.TTY.stream_ops.poll;
    const pty = Module.pty;
    Module.TTY.stream_ops.poll = function poll(stream, timeout) {
      if (!pty.readable) {
        return (pty.readable ? 1 : 0) | (pty.writable ? 4 : 0);
      }
      return previousPoll.call(stream, timeout);
    };
  }).catch((error) => {
    setProgress(`Startup failed: ${error}`, 0);
  });
}

setProgress("Loading the emulator", 0.08);
start(info);
