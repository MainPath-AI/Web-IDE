#!/usr/bin/env node
/*
 * Minimal native pre-snapshot client for code-server 4.143.1 / VS Code 1.143.1.
 * Wire definitions follow the Microsoft VS Code IPC implementation packaged in
 * lib/vscode/out/server-main.js (SHA-256
 * a4389c8698f6f9010189f9bbea14bc8b4687e207af7ef3a237b6406fd1257988):
 * src/vs/base/parts/ipc/common/ipc.ts and ipc.net.ts, and
 * src/vs/platform/remote/common/remoteAgentConnection.ts.
 * Release: https://github.com/coder/code-server/releases/tag/v4.143.1
 * Upstream source: https://github.com/microsoft/vscode (MIT).
 * This implements the wire contract; it does not modify the upstream bundles.
 *
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export const VSCODE_VERSION = "1.143.1";
const LIMIT = 64 * 1024 * 1024;
class VSBuffer { constructor(buffer) { this.buffer = buffer; } }

function varint(value) {
  let number = value >>> 0;
  const bytes = [];
  do {
    const next = number & 127;
    number >>>= 7;
    bytes.push(next | (number ? 128 : 0));
  } while (number);
  return Buffer.from(bytes);
}

// IPC tags: undefined=0, string=1, Buffer=2, VSBuffer=3, array=4,
// JSON object=5, int32=6. Lengths and integers use unsigned LEB128 on the wire.
export function serialize(value) {
  if (value === undefined) return Buffer.from([0]);
  if (typeof value === "string") {
    const bytes = Buffer.from(value);
    return Buffer.concat([Buffer.from([1]), varint(bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from([2]), varint(value.length), value]);
  if (value instanceof VSBuffer) return Buffer.concat([Buffer.from([3]), varint(value.buffer.length), value.buffer]);
  if (Array.isArray(value)) return Buffer.concat([Buffer.from([4]), varint(value.length), ...value.map(serialize)]);
  if (typeof value === "number" && (value | 0) === value) return Buffer.concat([Buffer.from([6]), varint(value)]);
  const bytes = Buffer.from(JSON.stringify(value));
  return Buffer.concat([Buffer.from([5]), varint(bytes.length), bytes]);
}

export function deserialize(buffer, offset = 0) {
  let position = offset;
  function take(length) {
    if (!Number.isSafeInteger(length) || length < 0 || length > buffer.length - position) throw new Error("Truncated IPC value");
    const result = buffer.subarray(position, position + length);
    position += length;
    return result;
  }
  function integer() {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const byte = take(1)[0];
      if (shift === 28 && (byte & 240)) throw new Error("Oversized IPC integer");
      value |= (byte & 127) << shift;
      if (!(byte & 128)) return value >>> 0;
    }
    throw new Error("Invalid IPC integer");
  }
  function read(depth = 0) {
    if (depth > 64) throw new Error("IPC nesting limit exceeded");
    switch (take(1)[0]) {
      case 0: return undefined;
      case 1: return take(integer()).toString("utf8");
      case 2:
      case 3: return Buffer.from(take(integer()));
      case 4: {
        const length = integer();
        if (length > buffer.length - position) throw new Error("Invalid IPC array length");
        return Array.from({ length }, () => read(depth + 1));
      }
      case 5: return JSON.parse(take(integer()).toString("utf8"));
      case 6: return integer() | 0;
      default: throw new Error("Unknown IPC value tag");
    }
  }
  return { value: read(), offset: position };
}

export function encodeFrame(type, id = 0, ack = 0, data = Buffer.alloc(0)) {
  if (data.length > LIMIT) throw new Error("IPC message limit exceeded");
  const header = Buffer.alloc(13);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(id, 1);
  header.writeUInt32BE(ack, 5);
  header.writeUInt32BE(data.length, 9);
  return Buffer.concat([header, data]);
}

export class FrameReader {
  buffer = Buffer.alloc(0);
  accept(chunk) {
    if (this.buffer.length + chunk.length > LIMIT + 13) throw new Error("IPC receive buffer limit exceeded");
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames = [];
    while (this.buffer.length >= 13) {
      const length = this.buffer.readUInt32BE(9);
      if (length > LIMIT) throw new Error("IPC message limit exceeded");
      if (this.buffer.length < 13 + length) break;
      frames.push({ type: this.buffer[0], id: this.buffer.readUInt32BE(1), ack: this.buffer.readUInt32BE(5), data: this.buffer.subarray(13, 13 + length) });
      this.buffer = this.buffer.subarray(13 + length);
    }
    return frames;
  }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // A socket can fail before a later startup phase starts awaiting its promise.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

async function deadline(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds); })]);
  } finally {
    clearTimeout(timer);
  }
}

function htmlDecode(value) {
  return value.replace(/&(?:quot|apos|amp|lt|gt|#\d+|#x[0-9a-f]+);/gi, (entity) => {
    const named = { "&quot;": '"', "&apos;": "'", "&amp;": "&", "&lt;": "<", "&gt;": ">" };
    if (entity.toLowerCase() in named) return named[entity.toLowerCase()];
    return String.fromCodePoint(entity[2].toLowerCase() === "x" ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10));
  });
}

export function parseWorkbench(html, documentURL) {
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)];
  const meta = metas.find(([tag]) => /\bid\s*=\s*["']vscode-workbench-web-configuration["']/i.test(tag));
  const setting = meta?.[0].match(/\bdata-settings\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  if (!setting) throw new Error("Backend did not serve a VS Code workbench configuration");
  const configuration = JSON.parse(htmlDecode(setting[1] ?? setting[2]));
  const product = configuration.productConfiguration ?? {};
  if (product.version && product.version !== VSCODE_VERSION) throw new Error("Unsupported VS Code version; review the pinned warmup protocol");
  const stable = html.match(/(?:\/|["'])stable-([0-9a-f]{40})(?:\/|["'])/i);
  const commit = product.commit ?? stable?.[1];
  if (!/^[0-9a-f]{40}$/i.test(commit ?? "")) throw new Error("Could not determine the backend product commit");
  // code-server patches the raw workbench configuration in its browser
  // bootstrap: coder-options.vscodeBase replaces serverBasePath. Its raw
  // serverBasePath and vscodeBase can both be document-relative (e.g. ".").
  let vscodeBase;
  for (const [tag] of metas) {
    const data = tag.match(/\bdata-settings\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (!data) continue;
    try {
      const options = JSON.parse(htmlDecode(data[1] ?? data[2]));
      if (typeof options?.vscodeBase === "string") vscodeBase = options.vscodeBase;
    } catch { /* Other workbench meta values can be URLs rather than JSON. */ }
  }
  const rawBase = vscodeBase ?? configuration.serverBasePath ?? ".";
  if (typeof rawBase !== "string" || /[?#\\]/.test(rawBase)) throw new Error("Invalid backend server base path");
  const document = new URL(documentURL);
  const resolved = new URL(rawBase, document);
  if (resolved.origin !== document.origin || resolved.username || resolved.password) throw new Error("Invalid backend server base origin");
  // RemoteAuthorities.setServerRootPath joins the base and product path.
  // Some code-server versions already include that suffix in vscodeBase.
  const productPath = `${product.quality ?? "stable"}-${commit}`;
  const base = resolved.pathname.replace(/\/$/, "");
  const basePath = base.endsWith(`/${productPath}`) ? base : `${base}/${productPath}`;
  return { commit, basePath, connectionToken: typeof configuration.connectionToken === "string" ? configuration.connectionToken : undefined };
}

class ManagementClient {
  reader = new FrameReader();
  opened = deferred();
  handshake = deferred();
  initialized = deferred();
  closed = deferred();
  pending = new Map();
  streams = new Map();
  unacknowledged = new Map();
  nextMessage = 0;
  receivedMessage = 0;
  nextRequest = 0;
  stage = "opening";
  paused = false;
  queued = [];
  error = null;

  constructor(url, configuration, { timeoutMs, WebSocketImpl }) {
    this.timeoutMs = timeoutMs;
    this.configuration = configuration;
    this.socket = new WebSocketImpl(url);
    this.socket.binaryType = "arraybuffer";
    this.socket.addEventListener("open", () => this.opened.resolve());
    this.socket.addEventListener("error", () => this.fail(new Error("Backend WebSocket failed")));
    this.socket.addEventListener("close", () => {
      this.closed.resolve();
      if (!this.closing) this.fail(new Error("Backend WebSocket closed before warmup completed"));
    });
    this.socket.addEventListener("message", (event) => {
      try {
        if (!(event.data instanceof ArrayBuffer)) throw new Error("Backend sent a non-binary WebSocket message");
        for (const frame of this.reader.accept(Buffer.from(event.data))) this.receive(frame);
      } catch (error) { this.fail(error); }
    });
  }

  fail(error) {
    if (this.error) return;
    this.error = error;
    this.opened.reject(error);
    this.handshake.reject(error);
    this.initialized.reject(error);
    for (const request of this.pending.values()) request.reject(error);
    for (const stream of this.streams.values()) stream.reject(error);
    this.pending.clear();
  }

  write(frame) {
    if (this.error) throw this.error;
    if (this.paused) this.queued.push(frame);
    else this.socket.send(frame);
  }

  send(type, data = Buffer.alloc(0)) {
    const id = type === 1 ? ++this.nextMessage : 0;
    const frame = encodeFrame(type, id, type === 2 || type === 5 ? 0 : this.receivedMessage, data);
    if (id) this.unacknowledged.set(id, frame);
    this.write(frame);
  }

  receive({ type, id, ack, data }) {
    if (ack > this.nextMessage) throw new Error("Backend acknowledged an unsent IPC message");
    for (const key of this.unacknowledged.keys()) if (key <= ack) this.unacknowledged.delete(key);
    if (type === 2) {
      const control = JSON.parse(data.toString());
      if (control.type === "error") throw new Error("Backend rejected the management handshake");
      if (this.stage === "sign" && control.type === "sign" && typeof control.data === "string") {
        // code-server's OSS guest has no vsda signing module. Like the OSS
        // client fallback, echo the challenge, or use its connection token.
        this.stage = "ok";
        this.send(2, Buffer.from(JSON.stringify({ type: "connectionType", commit: this.configuration.commit, signedData: this.configuration.connectionToken ?? control.data, desiredConnectionType: 1 })));
      } else if (this.stage === "ok" && control.type === "ok") {
        this.stage = "channels";
        this.handshake.resolve();
      } else throw new Error("Unexpected management handshake response");
    } else if (type === 1) {
      if (id <= this.receivedMessage) { this.send(3); return; }
      if (id !== this.receivedMessage + 1) { this.send(6); return; }
      this.receivedMessage = id;
      this.send(3);
      this.receiveIPC(data);
    } else if (type === 6) {
      for (const frame of this.unacknowledged.values()) this.write(frame);
    } else if (type === 7) this.paused = true;
    else if (type === 8) {
      this.paused = false;
      for (const frame of this.queued.splice(0)) this.write(frame);
    } else if (type === 5 && !this.closing) throw new Error("Backend disconnected the management protocol");
    else if (![0, 3, 5, 9].includes(type)) throw new Error("Unknown management protocol message");
  }

  receiveIPC(data) {
    const header = deserialize(data);
    const body = deserialize(data, header.offset);
    if (body.offset !== data.length || !Array.isArray(header.value)) throw new Error("Invalid IPC response envelope");
    const [type, id] = header.value;
    if (type === 200) { this.initialized.resolve(); return; }
    if (type === 100) {
      // The warm client does not offer download/UI channels. Return a real
      // IPC error instead of leaving a server-initiated request unanswered.
      this.send(1, Buffer.concat([serialize([202, id]), serialize({ name: "Unknown channel", message: "The native warmup client does not provide this channel" })]));
      return;
    }
    if (type === 204) { this.streams.get(id)?.accept(body.value); return; }
    if (type === 102 || type === 101 || type === 103) return;
    const request = this.pending.get(id);
    if (!request || ![201, 202, 203].includes(type)) throw new Error("Unexpected IPC response");
    this.pending.delete(id);
    if (type === 201) request.resolve(body.value);
    else request.reject(new Error(`Backend rejected RPC request ${id}`));
  }

  async connect() {
    await deadline(this.opened.promise, this.timeoutMs, "WebSocket connection");
    this.keepalive = setInterval(() => { try { this.send(9); } catch (error) { this.fail(error); } }, 5000);
    this.stage = "sign";
    this.send(2, Buffer.from(JSON.stringify({ type: "auth", auth: this.configuration.connectionToken ?? "00000000000000000000", data: randomUUID() })));
    await deadline(this.handshake.promise, this.timeoutMs, "Management handshake");
    this.send(1, serialize({ remoteAuthority: "warmup", clientId: "renderer" }));
    this.send(1, Buffer.concat([serialize([200]), serialize(undefined)]));
    await deadline(this.initialized.promise, this.timeoutMs, "IPC initialization");
  }

  async call(channel, method, argument) {
    if (this.error) throw this.error;
    const id = this.nextRequest++;
    const request = deferred();
    this.pending.set(id, request);
    this.send(1, Buffer.concat([serialize([100, id, channel, method]), serialize(argument)]));
    try { return await deadline(request.promise, this.timeoutMs, `${channel}.${method}`); }
    catch (error) {
      if (!this.error) this.send(1, Buffer.concat([serialize([101, id]), serialize(undefined)]));
      throw error;
    } finally { this.pending.delete(id); }
  }

  async close() {
    this.closing = true;
    clearInterval(this.keepalive);
    if (this.socket.readyState === 1) {
      try { this.socket.send(encodeFrame(5)); } catch {}
      this.socket.close(1000, "Native warmup complete");
    } else if (this.socket.readyState === 0) this.socket.close();
    if (this.socket.readyState !== 3) await deadline(this.closed.promise, 3000, "WebSocket close");
  }

  async readFileStream(uri) {
    const id = this.nextRequest++;
    const result = deferred();
    const chunks = [];
    this.streams.set(id, {
      reject: result.reject,
      accept: value => {
        if (Buffer.isBuffer(value)) chunks.push(value);
        else if (value === "end") result.resolve(Buffer.concat(chunks));
        else result.reject(new Error("Guest file stream failed"));
      },
    });
    this.send(1, Buffer.concat([serialize([102, id, "remoteFilesystem", "readFileStream"]), serialize([uri, {}])]));
    try { return await deadline(result.promise, this.timeoutMs, "Guest file stream"); }
    finally {
      this.streams.delete(id);
      if (!this.error) this.send(1, Buffer.concat([serialize([103, id]), serialize(undefined)]));
    }
  }
}

export async function warmGuest(backendURL, { timeoutMs = 120000, WebSocketImpl = globalThis.WebSocket, fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  const backend = new URL(backendURL);
  if (!["http:", "https:"].includes(backend.protocol) || backend.username || backend.password || backend.search || backend.hash) throw new Error("Use an HTTP backend URL without credentials, query, or fragment");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid warmup timeout");
  if (!WebSocketImpl || !fetchImpl) throw new Error("Node.js with built-in fetch and WebSocket is required");
  log("BEGIN workbench discovery");
  const response = await fetchImpl(backend, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  if (!response.ok) throw new Error(`Backend workbench returned HTTP ${response.status}`);
  const html = await deadline(response.text(), timeoutMs, "Workbench document");
  if (html.length > LIMIT) throw new Error("Workbench document limit exceeded");
  const configuration = parseWorkbench(html, response.url || backend.href);
  const url = new URL(configuration.basePath, backend);
  url.protocol = backend.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("reconnectionToken", randomUUID());
  url.searchParams.set("reconnection", "false");
  url.searchParams.set("skipWebSocketFrames", "false");
  const client = new ManagementClient(url, configuration, { timeoutMs, WebSocketImpl });
  try {
    log("BEGIN management connection");
    await client.connect();
    log("management connected");
    log("BEGIN guest environment");
    const environment = await client.call("remoteextensionsenvironment", "getEnvironmentData", { remoteAuthority: "warmup" });
    if (!Number.isInteger(environment?.pid) || environment.pid <= 0 || environment.os !== 3 || environment.arch !== "x64") throw new Error("Backend did not return an amd64 Linux environment");
    log("guest environment ready");
    log("BEGIN extension scan");
    const extensions = await client.call("remoteExtensionsScanner", "scanExtensions", ["en", null, [], [], null]);
    // RemoteExtensionsScanner returns ExtensionDescription, not the scanner's
    // internal IScannedExtension: its ExtensionIdentifier stores `value`, and
    // the flattened description also has a top-level `id`.
    if (!Array.isArray(extensions) || !extensions.length || extensions.some((extension) => typeof extension?.identifier?.value !== "string" || extension.id !== extension.identifier.value)) throw new Error("Backend did not return scanned extensions");
    log(`extensions ready (${extensions.length})`);
    log("BEGIN guest demo directory");
    const entries = await client.call("remoteFilesystem", "readdir", [{ $mid: 1, scheme: "vscode-remote", authority: "warmup", path: "/opt/web-ide/demos" }]);
    if (!Array.isArray(entries) || entries.some((entry) => !Array.isArray(entry) || typeof entry[0] !== "string")) throw new Error("Backend did not return a guest directory");
    for (const [name, type] of [["python", 2], ["node", 2], ["hugo", 2], ["run-all.sh", 1]]) {
      if (!entries.some((entry) => entry[0] === name && (entry[1] & type))) throw new Error(`Guest demo entry is missing: ${name}`);
    }
    log("guest demo directory ready");
    const resource = path => ({ $mid: 1, scheme: "vscode-remote", authority: "warmup", path });
    log("BEGIN guest file read and write");
    const source = await client.readFileStream(resource("/opt/web-ide/demos/run-all.sh"));
    if (!source.toString("utf8").includes("python/hello.py")) throw new Error("Guest demo file could not be read");
    const probe = resource("/tmp/web-ide-warmup.txt");
    const probeBytes = Buffer.from("web-ide native file warmup\n");
    await client.call("remoteFilesystem", "writeFile", [probe, new VSBuffer(probeBytes), { create: true, overwrite: true, unlock: false, atomic: false }]);
    const saved = await client.call("remoteFilesystem", "readFile", [probe, {}]);
    if (!Buffer.isBuffer(saved) || !saved.equals(probeBytes)) throw new Error("Guest file save did not round trip");
    await client.call("remoteFilesystem", "delete", [probe, { recursive: false, useTrash: false, atomic: false }]);
    log("guest file read and write ready");
    log("BEGIN PTY host");
    const latency = await client.call("remoteterminal", "$getLatency", []);
    if (!Array.isArray(latency) || !latency.length || latency.some((entry) => typeof entry?.latency !== "number" || !Number.isFinite(entry.latency) || entry.latency < 0)) throw new Error("PTY host did not return a latency response");
    log("PTY host ready");
    log("BEGIN actual Bash PTY");
    const terminal = await client.call("remoteterminal", "$createProcess", {
      shellLaunchConfig: { executable: "/bin/bash", args: ["--noprofile", "--norc"], cwd: "/opt/web-ide/demos", useShellEnvironment: false },
      workspaceFolders: [], resolverEnv: {}, resolvedVariables: {}, envVariableCollections: [],
      configuration: { "terminal.integrated.env.linux": { NODE_OPTIONS: null }, "terminal.integrated.detectLocale": "off" },
      cols: 80, rows: 24, unicodeVersion: "11", shouldPersistTerminal: false,
      workspaceId: "web-ide-warmup", workspaceName: "demos", options: { shellIntegration: { enabled: false } },
    });
    const terminalId = terminal?.persistentTerminalId;
    if (!Number.isInteger(terminalId) || terminalId < 1) throw new Error("Guest did not create a real PTY");
    try {
      const startError = await client.call("remoteterminal", "$start", [terminalId]);
      if (startError) throw new Error("Guest Bash PTY did not start");
    } finally { await client.call("remoteterminal", "$shutdown", [terminalId, true]); }
    log("actual Bash PTY ready");
    log("BEGIN embedded server isolation");
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      const table = await client.call("remoteFilesystem", "readFile", [resource(file), {}]);
      if (!Buffer.isBuffer(table)) throw new Error("Guest TCP listeners could not be inspected");
      for (const line of table.toString("utf8").trim().split("\n").slice(1)) {
        const columns = line.trim().split(/\s+/);
        if (columns[3] === "0A" && parseInt(columns[1]?.split(":")[1], 16) === 8000) {
          throw new Error("Embedded VS Code started a duplicate standalone server");
        }
      }
    }
    log("embedded server isolation ready");
    return { commit: configuration.commit, extensionCount: extensions.length, demoEntryCount: entries.length, ptyHostReady: true, fileSaveReady: true, bashPtyReady: true, singleServerReady: true };
  } finally {
    await client.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const backend = args.shift();
  let timeoutMs = 120000;
  if (args[0] === "--timeout-ms" && /^\d+$/.test(args[1] ?? "")) { timeoutMs = Number(args[1]); args.splice(0, 2); }
  if (!backend || args.length || timeoutMs <= 0 || timeoutMs > 600000) throw new Error("Usage: node scripts/warm-guest.mjs BACKEND_URL [--timeout-ms 120000]");
  // The CLI watchdog also bounds a stalled close handshake or network handle.
  const watchdog = setTimeout(() => { process.stderr.write("WEB_IDE_WARMUP_FAILED total deadline exceeded\n"); process.exit(1); }, timeoutMs * 7 + 5000);
  try {
    const result = await warmGuest(backend, { timeoutMs, log: (message) => process.stdout.write(`WEB_IDE_WARMUP ${message}\n`) });
    process.stdout.write(`WEB_IDE_WARMUP_READY ${JSON.stringify(result)}\n`);
  } finally { clearTimeout(watchdog); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Never print server environment data, connection tokens, URLs, or raw
    // protocol errors. Phase markers above identify the last completed step.
    process.stderr.write("WEB_IDE_WARMUP_FAILED backend RPC warmup did not complete\n");
    process.exit(1);
  });
}
