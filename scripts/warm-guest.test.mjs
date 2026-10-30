import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { deserialize, encodeFrame, FrameReader, parseWorkbench, serialize, warmGuest } from "./warm-guest.mjs";

const commit = "0123456789abcdef0123456789abcdef01234567";
const html = `<meta id="vscode-workbench-web-configuration" data-settings="{&quot;serverBasePath&quot;:&quot;/&quot;,&quot;productConfiguration&quot;:{&quot;version&quot;:&quot;1.143.1&quot;,&quot;commit&quot;:&quot;${commit}&quot;}}"><script src="/stable-${commit}/static/out/vs/code/browser/workbench/workbench.js"></script>`;

test("IPC values match upstream wire fixtures, including signed int32 and UTF-8 lengths", () => {
  const fixtures = [
    [undefined, "00"], ["é", "0102c3a9"], [0, "0600"], [128, "068001"], [-1, "06ffffffff0f"],
    [[200], "040106c801"], [[100, 0, "x", "y"], "040406640600010178010179"],
    [{ a: true }, "050a7b2261223a747275657d"], [Buffer.from([1, 2]), "02020102"],
  ];
  for (const [value, hex] of fixtures) {
    assert.equal(serialize(value).toString("hex"), hex);
    assert.deepEqual(deserialize(Buffer.from(hex, "hex")).value, value);
  }
  assert.deepEqual(deserialize(Buffer.from("03020102", "hex")).value, Buffer.from([1, 2]));
  assert.throws(() => deserialize(Buffer.from("010561", "hex")), /Truncated/);
  assert.throws(() => deserialize(Buffer.from("06808080808000", "hex")), /Oversized/);
});

test("persistent messages retain boundaries across fragmented and coalesced WebSocket payloads", () => {
  const reader = new FrameReader();
  // Type 1, id 2, acknowledgement 3, payload 0x040106c80100 (IPC Initialize).
  const first = Buffer.from("01000000020000000300000006040106c80100", "hex");
  assert.equal(encodeFrame(1, 2, 3, Buffer.from("040106c80100", "hex")).toString("hex"), first.toString("hex"));
  const second = encodeFrame(9);
  const frames = [];
  for (const byte of Buffer.concat([first, second])) frames.push(...reader.accept(Buffer.from([byte])));
  assert.equal(frames.length, 2);
  assert.deepEqual({ ...frames[0], data: frames[0].data.toString("hex") }, { type: 1, id: 2, ack: 3, data: "040106c80100" });
  assert.equal(frames[1].type, 9);
  const invalid = Buffer.alloc(13);
  invalid.writeUInt32BE(0xffffffff, 9);
  assert.throws(() => new FrameReader().accept(invalid), /limit/);
});

test("HTML discovery uses the product commit, validates version, and retains tokens only internally", () => {
  assert.deepEqual(parseWorkbench(html, "http://localhost:18081/"), { commit, basePath: `/stable-${commit}`, connectionToken: undefined });
  const fallback = html.replace(`,&quot;commit&quot;:&quot;${commit}&quot;`, "");
  assert.equal(parseWorkbench(fallback, "http://localhost:18081/").commit, commit);
  assert.throws(() => parseWorkbench(html.replace("1.143.1", "1.1.0"), "http://localhost/"), /Unsupported/);
  assert.throws(() => parseWorkbench("<html>Loading</html>", "http://localhost/"), /configuration/);
});

test("code-server's document-relative vscodeBase overrides the raw workbench base", () => {
  const raw = html.replace('&quot;serverBasePath&quot;:&quot;/&quot;', '&quot;serverBasePath&quot;:&quot;.&quot;');
  const options = `<meta id="coder-options" data-settings="{&quot;base&quot;:&quot;.&quot;,&quot;vscodeBase&quot;:&quot;./stable-${commit}&quot;}">`;
  assert.equal(parseWorkbench(raw + options, "http://localhost:18085/").basePath, `/stable-${commit}`);
  assert.equal(parseWorkbench(raw + options, "http://localhost:18085/prefix/").basePath, `/prefix/stable-${commit}`);
  assert.equal(parseWorkbench(raw, "http://localhost:18085/").basePath, `/stable-${commit}`);
  assert.throws(() => parseWorkbench(raw + options.replace(`./stable-${commit}`, "https://another.invalid/"), "http://localhost/"), /origin/);
});

function webSocketFrame(opcode, payload) {
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  header[0] = 0x80 | opcode;
  if (header.length === 2) header[1] = payload.length;
  else { header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  return Buffer.concat([header, payload]);
}

// This is a raw RFC6455 endpoint, not a mocked WebSocket object. The client
// uses Node's real built-in WebSocket, including masking and close frames.
async function backend(t, mode = "ok") {
  const requests = [];
  const sockets = new Set();
  const failures = [];
  let disconnected = false;
  const server = createServer((request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end(html); });
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    const key = createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n\r\n`);
    let network = Buffer.alloc(0);
    let stream = Buffer.alloc(0);
    let phase = "auth";
    let incomingId = 0;
    let outgoingId = 0;
    function send(type, data = Buffer.alloc(0)) {
      const frame = encodeFrame(type, type === 1 ? ++outgoingId : 0, incomingId, data);
      // Split the VS Code header itself across two distinct WebSocket messages.
      socket.write(webSocketFrame(2, frame.subarray(0, 7)));
      socket.write(webSocketFrame(2, frame.subarray(7)));
    }
    function reply(id, value, type = 201) { send(1, Buffer.concat([serialize([type, id]), serialize(value)])); }
    function accept(payload) {
      stream = Buffer.concat([stream, payload]);
      while (stream.length >= 13) {
        const length = stream.readUInt32BE(9);
        if (stream.length < 13 + length) return;
        const type = stream[0];
        const id = stream.readUInt32BE(1);
        const body = stream.subarray(13, 13 + length);
        stream = stream.subarray(13 + length);
        if (type === 5) { disconnected = true; continue; }
        if (type === 2) {
          const control = JSON.parse(body.toString());
          if (phase === "auth") {
            assert.equal(control.type, "auth");
            assert.equal(control.auth, "00000000000000000000");
            phase = "connectionType";
            send(2, Buffer.from(JSON.stringify({ type: "sign", data: "challenge", signedData: control.data })));
          } else {
            assert.equal(control.type, "connectionType");
            assert.equal(control.signedData, "challenge");
            assert.equal(control.desiredConnectionType, 1);
            assert.equal(control.commit, commit);
            phase = "context";
            send(2, Buffer.from('{"type":"ok"}'));
          }
        } else if (type === 1) {
          assert.equal(id, ++incomingId);
          const header = deserialize(body);
          if (phase === "context") {
            assert.deepEqual(header.value, { remoteAuthority: "warmup", clientId: "renderer" });
            phase = "rpc";
            send(1, Buffer.from("040106c80100", "hex"));
            continue;
          }
          const [kind, requestId, channel, method] = header.value;
          const argument = deserialize(body, header.offset).value;
          if (kind === 200 || kind === 101 || kind === 103) continue;
          if (kind === 102) {
            requests.push({ channel, method, argument });
            assert.equal(method, "readFileStream");
            reply(requestId, mode === "read-failed" ? { message: "unreadable" } : Buffer.from("python/hello.py\n"), 204);
            reply(requestId, "end", 204);
            continue;
          }
          assert.equal(kind, 100);
          requests.push({ channel, method, argument });
          if (mode === "timeout" && method === "$getLatency") continue;
          if (mode === "reject" && method === "$getLatency") { reply(requestId, { name: "Error", message: "Child not ready" }, 202); continue; }
          if (method === "getEnvironmentData") reply(requestId, { pid: 42, os: 3, arch: "x64", connectionToken: "must-never-be-logged" });
          else if (method === "scanExtensions") reply(requestId, [{ id: "vscode.python", identifier: { value: "vscode.python" } }]);
          else if (method === "readdir") reply(requestId, mode === "missing-demo" ? [] : [["python", 2], ["node", 2], ["hugo", 2], ["run-all.sh", 1]]);
          else if (method === "$getLatency") reply(requestId, [{ label: "ptyhostservice<->ptyhost", latency: 1 }]);
          else if (method === "writeFile" || method === "delete" || method === "$shutdown") reply(requestId, undefined);
          else if (method === "readFile") reply(requestId, Buffer.from(mode === "save-failed" ? "wrong" : "web-ide native file warmup\n"));
          else if (method === "$createProcess") reply(requestId, { persistentTerminalId: mode === "missing-pty" ? 0 : 7 });
          else if (method === "$start") reply(requestId, mode === "bash-failed" ? { message: "spawn failed" } : undefined);
          else throw new Error("Unexpected test RPC");
        }
      }
    }
    socket.on("data", (chunk) => {
      try {
        network = Buffer.concat([network, chunk]);
        while (network.length >= 2) {
          const opcode = network[0] & 15;
          const masked = !!(network[1] & 128);
          let length = network[1] & 127;
          let position = 2;
          if (length === 126) { if (network.length < 4) return; length = network.readUInt16BE(2); position = 4; }
          assert.notEqual(length, 127);
          assert.equal(masked, true);
          if (network.length < position + 4 + length) return;
          const mask = network.subarray(position, position + 4);
          const payload = Buffer.from(network.subarray(position + 4, position + 4 + length));
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
          network = network.subarray(position + 4 + length);
          if (opcode === 8) { socket.end(webSocketFrame(8, payload)); continue; }
          if (opcode === 9) { socket.write(webSocketFrame(10, payload)); continue; }
          assert.equal(opcode, 2);
          accept(payload);
        }
      } catch (error) { failures.push(error); socket.destroy(); }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(failures, []);
  });
  return { url: `http://127.0.0.1:${server.address().port}/`, requests, get disconnected() { return disconnected; } };
}

test("real WebSocket file stream, save round trip and Bash PTY are required before snapshot readiness", async (t) => {
  const server = await backend(t);
  const logs = [];
  const result = await warmGuest(server.url, { timeoutMs: 2000, log: (message) => logs.push(message) });
  assert.deepEqual(result, { commit, extensionCount: 1, demoEntryCount: 4, ptyHostReady: true, fileSaveReady: true, bashPtyReady: true });
  assert.deepEqual(server.requests.map(({ channel, method }) => [channel, method]), [
    ["remoteextensionsenvironment", "getEnvironmentData"], ["remoteExtensionsScanner", "scanExtensions"],
    ["remoteFilesystem", "readdir"], ["remoteFilesystem", "readFileStream"],
    ["remoteFilesystem", "writeFile"], ["remoteFilesystem", "readFile"], ["remoteFilesystem", "delete"],
    ["remoteterminal", "$getLatency"], ["remoteterminal", "$createProcess"],
    ["remoteterminal", "$start"], ["remoteterminal", "$shutdown"],
  ]);
  assert.deepEqual(server.requests[1].argument, ["en", null, [], [], null]);
  assert.equal(server.requests[2].argument[0].path, "/opt/web-ide/demos");
  assert.equal(server.disconnected, true);
  assert.doesNotMatch(JSON.stringify({ result, logs }), /must-never-be-logged/);
});

for (const mode of ["timeout", "reject", "missing-demo", "read-failed", "save-failed", "missing-pty", "bash-failed"]) {
  test(`${mode} cannot produce a successful warmup`, async (t) => {
    const server = await backend(t, mode);
    await assert.rejects(warmGuest(server.url, { timeoutMs: mode === "timeout" ? 100 : 2000 }), /timed out|rejected|missing|stream failed|round trip|real PTY|did not start/);
    assert.equal(server.disconnected, true);
  });
}
