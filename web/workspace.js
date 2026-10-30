// Files stay on this device. Only this tab's guest receives the restored tar.
const baseHeaders = { "X-Web-IDE-Workspace": "1" };
let endpoint, database, savedRevision, active = false, busy = false, timer;
const status = () => document.getElementById("workspace-status");
function message(text) { status().textContent = text; }

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("web-ide-workspaces", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("backups");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Workspace storage is blocked by another tab."));
  });
}

function storedBackup() {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("backups", "readonly");
    const request = transaction.objectStore("backups").get("workspace");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function storeBackup(blob) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("backups", "readwrite");
    transaction.objectStore("backups").put({ blob, savedAt: Date.now() }, "workspace");
    transaction.oncomplete = resolve;
    transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error("Workspace storage failed."));
  });
}

async function request(path, options = {}) {
  const response = await fetch(endpoint + path, {
    ...options, headers: { ...baseHeaders, ...options.headers }, cache: "no-store",
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`Workspace request failed (${response.status}).`);
  return response;
}

async function save(force = false) {
  if (!active || busy) return;
  busy = true;
  try {
    const { revision } = await (await request("/status")).json();
    if (!force && revision === savedRevision) return;
    message("Saving workspace in this browser…");
    const response = await request("/archive");
    const archiveRevision = Number(response.headers.get("X-Workspace-Revision"));
    if (!Number.isSafeInteger(archiveRevision) || archiveRevision < 1) throw new Error("Invalid workspace revision.");
    const blob = await response.blob();
    if (!blob.size || blob.size > 100 * 1024 * 1024) throw new Error("Workspace backup exceeds 100 MiB.");
    await storeBackup(blob);
    savedRevision = archiveRevision;
    message(`Workspace saved in this browser at ${new Date().toLocaleTimeString()}`);
  } catch (error) {
    message("Workspace could not be saved. Keep this tab open or download a backup.");
    console.error("Workspace backup failed", error.message);
  } finally { busy = false; }
}

async function download() {
  try {
    const response = await request("/archive");
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = "web-ide-workspace.tar";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch { message("Download failed. Keep this tab open and try again."); }
}

// Hold an origin-wide lock for this tab's lifetime. A second guest can run,
// but cannot overwrite the first tab's durable workspace with its own files.
async function acquireLock() {
  if (!navigator.locks) return false;
  return new Promise((resolve, reject) => {
    navigator.locks.request("web-ide-workspace", { ifAvailable: true }, async lock => {
      resolve(!!lock);
      if (lock) await new Promise(() => {});
    }).catch(reject);
  });
}

window.webIdeWorkspace = {
  async initialize(session) {
    endpoint = `/sessions/${session}/workspace`;
    document.getElementById("workspace-tools").hidden = false;
    document.getElementById("save-workspace").addEventListener("click", () => save(true));
    document.getElementById("download-workspace").addEventListener("click", download);
    try {
      const ownsStorage = await acquireLock();
      if (!ownsStorage) {
        message("Another tab owns autosave. This tab is temporary; download files before closing.");
        document.getElementById("save-workspace").disabled = true;
        await request("/ready", { method: "POST" });
        return;
      }
      database = await openDatabase();
      const backup = await storedBackup();
      if (backup) {
        if (!(backup.blob instanceof Blob) || backup.blob.size > 100 * 1024 * 1024) throw new Error("Invalid stored workspace.");
        message("Restoring workspace from this browser…");
        await request("/restore", { method: "POST", body: backup.blob, headers: { "Content-Type": "application/x-tar" } });
      } else await request("/ready", { method: "POST" });
      active = true;
      message("Workspace autosave is active in this browser.");
      const poll = async () => { await save(); timer = setTimeout(poll, 3000); };
      timer = setTimeout(poll, 1000);
      window.addEventListener("pagehide", () => clearTimeout(timer));
      window.addEventListener("beforeunload", event => { if (busy) { event.preventDefault(); event.returnValue = ""; } });
    } catch (error) {
      message("Workspace restore failed. Your saved backup is unchanged.");
      throw error;
    }
  },
};
