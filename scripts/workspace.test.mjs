import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../web/workspace.js", import.meta.url), "utf8");

function browser({ ownsLock = true, quota = false, revisionHeader = "2" } = {}) {
  const original = { blob: new Blob(["previous backup"]), savedAt: 123 };
  const state = { backup: original, writes: 0, restores: 0, requests: [], timers: [] };
  const elements = Object.fromEntries(["workspace-tools", "workspace-status", "save-workspace", "download-workspace"].map(id => [id, { listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; } }]));
  const database = {
    transaction(_store, mode) {
      const transaction = { objectStore: () => ({
        get: () => { const request = {}; queueMicrotask(() => { request.result = state.backup; request.onsuccess(); }); return request; },
        put: value => queueMicrotask(() => {
          if (quota) { transaction.error = new Error("Quota exceeded"); transaction.onabort(); }
          else { state.backup = value; state.writes++; transaction.oncomplete(); }
        }),
      }) };
      return transaction;
    },
  };
  const context = vm.createContext({
    Blob, AbortSignal, URL, Date, Promise, console: { error() {} },
    document: { getElementById: id => elements[id] },
    navigator: { locks: { request: async (_name, _options, callback) => callback(ownsLock ? {} : null) } },
    indexedDB: { open: () => { const request = {}; queueMicrotask(() => { request.result = database; request.onsuccess(); }); return request; } },
    setTimeout: callback => { state.timers.push(callback); return state.timers.length; }, clearTimeout() {},
    addEventListener() {},
    fetch: async (url, options) => {
      state.requests.push(url);
      assert.equal(options.headers["X-Web-IDE-Workspace"], "1");
      if (url.endsWith("/restore")) { assert.equal(options.body, original.blob); state.restores++; }
      return { ok: true, status: 200, json: async () => ({ revision: 2 }), headers: { get: () => revisionHeader }, blob: async () => new Blob(["current backup"]) };
    },
  });
  context.window = context;
  vm.runInContext(source, context);
  return { context, state, elements, original };
}

test("restores the previous browser backup before starting autosave", async () => {
  const h = browser();
  await h.context.webIdeWorkspace.initialize("session");
  assert.equal(h.state.restores, 1);
  assert.equal(h.state.writes, 0);
  await h.state.timers.shift()();
  assert.equal(h.state.writes, 1);
  assert.equal(await h.state.backup.blob.text(), "current backup");
  assert.match(h.elements["workspace-status"].textContent, /saved in this browser/);
});

test("a quota failure preserves the last committed backup and remains visible", async () => {
  const h = browser({ quota: true });
  await h.context.webIdeWorkspace.initialize("session");
  await h.state.timers.shift()();
  assert.equal(h.state.backup, h.original);
  assert.equal(h.state.writes, 0);
  assert.match(h.elements["workspace-status"].textContent, /could not be saved/);
});

test("a second tab cannot overwrite the active tab's browser backup", async () => {
  const h = browser({ ownsLock: false });
  await h.context.webIdeWorkspace.initialize("session");
  assert.equal(h.state.backup, h.original);
  assert.equal(h.state.writes, 0);
  assert.equal(h.state.timers.length, 0);
  assert.equal(h.elements["save-workspace"].disabled, true);
  assert.match(h.elements["workspace-status"].textContent, /temporary/);
});

test("a malformed archive response cannot replace a committed backup", async () => {
  const h = browser({ revisionHeader: null });
  await h.context.webIdeWorkspace.initialize("session");
  await h.state.timers.shift()();
  assert.equal(h.state.backup, h.original);
  assert.equal(h.state.writes, 0);
});
